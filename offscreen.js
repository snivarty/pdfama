// offscreen.js

import { VectorDB } from '/lib/vectoridb/index.js';
import { pipeline, env } from '/lib/transformers/transformers.min.js';

// --- CONFIGURATION ---
const CHUNK_SIZE = 1024;
const CHUNK_OVERLAP = 100;
const TOKEN_LIMIT = 32000; // A conservative token limit for Gemini Nano
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

// VectorDB specific configuration
const DB_NAME = 'pdfAMAVectorDB';
const OBJECT_STORE_NAME = 'pdfVectors';
const VECTOR_PROPERTY_NAME = 'embedding'; // The property name within the stored object that holds the vector

// --- STATE ---
let chatSession;
let abortController = null;
let ragPipeline = null; // Will hold the RAG pipeline for large documents

// --- ENVIRONMENT SETUP ---
// Skip local model checks for a streamlined setup.
env.allowLocalModels = false;

// --- CUSTOM TEXT SPLITTER ---
class RecursiveCharacterTextSplitter {
    constructor(fields) {
        this.chunkSize = fields?.chunkSize ?? 1000;
        this.chunkOverlap = fields?.chunkOverlap ?? 200;
        this.separators = fields?.separators ?? ["\n\n", "\n", " ", ""];
        if (this.chunkOverlap >= this.chunkSize) {
            throw new Error("Cannot have chunkOverlap >= chunkSize");
        }
    }

    async splitText(text) {
        return this._splitText(text, this.separators);
    }

    async _splitText(text, separators) {
        const finalChunks = [];
        let separator = separators[separators.length - 1];
        let newSeparators;

        for (let i = 0; i < separators.length; i += 1) {
            const s = separators[i];
            if (s === "") {
                separator = s;
                break;
            }
            if (text.includes(s)) {
                separator = s;
                newSeparators = separators.slice(i + 1);
                break;
            }
        }

        const splits = text.split(separator);
        let goodSplits = [];

        for (const s of splits) {
            if (s.length < this.chunkSize) {
                goodSplits.push(s);
            } else {
                if (goodSplits.length) {
                    finalChunks.push(...this.mergeSplits(goodSplits, separator));
                    goodSplits = [];
                }
                if (!newSeparators) {
                    finalChunks.push(s);
                } else {
                    finalChunks.push(...await this._splitText(s, newSeparators));
                }
            }
        }

        if (goodSplits.length) {
            finalChunks.push(...this.mergeSplits(goodSplits, separator));
        }
        return finalChunks;
    }

    mergeSplits(splits, separator) {
        const docs = [];
        const currentDoc = [];
        let total = 0;
        for (const d of splits) {
            const _len = d.length;
            if (total + _len + (currentDoc.length > 0 ? separator.length : 0) > this.chunkSize) {
                if (total > this.chunkSize) {
                    console.warn(`Created a chunk of size ${total}, which is longer than the specified ${this.chunkSize}`);
                }
                if (currentDoc.length > 0) {
                    const doc = currentDoc.join(separator).trim();
                    if (doc !== "") {
                        docs.push(doc);
                    }
                    while (total > this.chunkOverlap || (total + _len > this.chunkSize && total > 0)) {
                        total -= currentDoc[0].length;
                        currentDoc.shift();
                    }
                }
            }
            currentDoc.push(d);
            total += _len;
        }
        const doc = currentDoc.join(separator).trim();
        if (doc !== "") {
            docs.push(doc);
        }
        return docs;
    }
}

// --- CLASSES ---
/**
 * Manages the entire RAG (Retrieval-Augmented Generation) pipeline.
 */
class RagPipeline {
    constructor(text) {
        this.text = text;
        this.vectorStore = null;
        this.embedder = null;
    }

    /**
     * Initializes the pipeline by creating embeddings and the vector store.
     */
    async init() {
        chrome.runtime.sendMessage({ type: 'status-update', message: 'Initializing AI model...' });
        this.embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);

        chrome.runtime.sendMessage({ type: 'status-update', message: 'Chunking document...' });
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: CHUNK_SIZE,
            chunkOverlap: CHUNK_OVERLAP,
        });
        const chunks = await splitter.splitText(this.text);

        chrome.runtime.sendMessage({ type: 'status-update', message: 'Creating vector store...' });
        this.vectorStore = new VectorDB({
            dbName: DB_NAME,
            objectStore: OBJECT_STORE_NAME,
            vectorPath: VECTOR_PROPERTY_NAME,
            vectorDimensions: 384 // Dimensions for all-MiniLM-L6-v2
        });

        chrome.runtime.sendMessage({ type: 'status-update', message: 'Generating embeddings (this may take a while)...' });
        let processedChunks = 0;
        for (const chunk of chunks) {
            const embedding = await this.embedder(chunk, { pooling: 'mean', normalize: true });
            // VectorDB expects an object with the vector at 'vectorPath', and the vector must be a standard Array.
            await this.vectorStore.insert({
                text: chunk, // Store the original text chunk
                [VECTOR_PROPERTY_NAME]: Array.from(embedding.data) // Convert TypedArray to Array
            });
            processedChunks++;
            if (processedChunks % 10 === 0) { // Update every 10 chunks
                 chrome.runtime.sendMessage({ type: 'status-update', message: `Embedding... (${processedChunks}/${chunks.length})` });
            }
        }
    }

    /**
     * Retrieves relevant context from the vector store based on a query.
     * @param {string} query - The user's question.
     * @returns {Promise<string>} The retrieved context.
     */
    async retrieve(query) {
        const queryEmbedding = await this.embedder(query, { pooling: 'mean', normalize: true });
        // VectorDB's query method returns objects with 'object' and 'similarity'
        const results = await this.vectorStore.query(queryEmbedding.data, { limit: 3 }); // Get top 3 results
        return results.map(r => r.object.text).join('\n\n---\n\n');
    }
}


// Listen for commands from the Butler (background.js)
chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'start-processing') {
    await processPdfAndInitAi(message.url);
  } else if (message.type === 'ask-question') {
    console.log("[pdfAMA Engine Room]: Received question:", message.question);
    await handleAskQuestion(message.question);
  } else if (message.type === 'terminate-chat') {      // NEW
    console.log("[pdfAMA Engine Room]: Termination requested.");
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }
});

async function processPdfAndInitAi(url) {
  try {
    chrome.runtime.sendMessage({ type: 'status-update', message: 'Processing PDF...' });
    
    // Step 1: Fetch and Parse the PDF
    const { getDocument, GlobalWorkerOptions } = await import(chrome.runtime.getURL('lib/pdfjs/build/pdf.mjs'));
    
    // Use a dedicated worker loader script to handle PDF.js worker imports
    GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/build/pdfjs-worker-loader.js');

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
    const pdfData = await response.arrayBuffer();
    if (pdfData.byteLength === 0) throw new Error("Fetched PDF is empty. Ensure 'Allow access to file URLs' is enabled for the extension.");
    
    const typedArray = new Uint8Array(pdfData);
    const pdf = await getDocument({ data: typedArray }).promise;
    let textContent = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        textContent += (await (await pdf.getPage(i)).getTextContent()).items.map(item => item.str).join(' ');
    }

    // Step 2: Initialize the AI based on document size
    if (!self.LanguageModel) throw new Error("LanguageModel API not available.");
    const availability = await self.LanguageModel.availability({expectedOutputs: [{ type: "text", languages: ["en"] }]});
    if (availability !== 'available') throw new Error(`AI model not available: ${availability}`);

    if (textContent.length > TOKEN_LIMIT) {
        // --- RAG PATH for Large Documents ---
        ragPipeline = new RagPipeline(textContent);
        await ragPipeline.init();
    } else {
        // --- Direct Path for Small Documents ---
        ragPipeline = null; // Ensure RAG is not used
        chatSession = await self.LanguageModel.create({
            initialPrompts: [
                { role: 'system', content: 'You are a helpful assistant. Answer based *only* on the provided text.' },
                { role: 'user', content: textContent }
            ],
            expectedInputs: [{ type: "text", languages: ["en"] }],
            expectedOutputs: [{ type: "text", languages: ["en"] }]
        });
    }
    
    chrome.runtime.sendMessage({ type: 'status-update', message: 'Ready to chat.' });
    chrome.runtime.sendMessage({ type: 'init-chat', history: [] });

  } catch (error) {
    console.error('[pdfAMA Engine Room]: CRITICAL ERROR:', error);
    chrome.runtime.sendMessage({ type: 'error', message: error.message });
  }
}

async function handleAskQuestion(question) {
    console.log("[pdfAMA Engine Room]: Received question:", question);
    abortController = new AbortController();
    const { signal } = abortController;

    try {
        let stream;
        if (ragPipeline) {
            // --- RAG Query ---
            chrome.runtime.sendMessage({ type: 'status-update', message: 'Searching document...' });
            const context = await ragPipeline.retrieve(question);
            const augmentedPrompt = `Based on the following text, answer the question: "${question}"\n\n---\n\n${context}`;
            
            // For RAG, we create a new session for each query
            const ragSession = await self.LanguageModel.create({
                 initialPrompts: [{ role: 'system', content: 'You are a helpful assistant. Answer based *only* on the provided text.' }],
                 expectedInputs: [{ type: "text", languages: ["en"] }],
                 expectedOutputs: [{ type: "text", languages: ["en"] }]
            });
            stream = await ragSession.promptStreaming(augmentedPrompt, { signal });

        } else if (chatSession) {
            // --- Direct Query ---
            stream = await chatSession.promptStreaming(question, { signal });
        } else {
            throw new Error('AI session not ready.');
        }

        for await (const chunk of stream) {
            if (signal.aborted) {
                console.log("[pdfAMA Engine Room]: Streaming aborted.");
                return;
            }
            chrome.runtime.sendMessage({ type: 'ama-chunk', chunk: chunk });
        }
        chrome.runtime.sendMessage({ type: 'ama-complete' });

    } catch (error) {
        if (error.name === 'AbortError' || (signal && signal.aborted)) {
            console.log("[pdfAMA Engine Room]: Chat was aborted by user.");
            chrome.runtime.sendMessage({ type: 'ama-terminated' });
        } else {
            console.error('[pdfAMA Engine Room]: AI Query Error:', error);
            chrome.runtime.sendMessage({ type: 'error', message: `AI Error: ${error.message}` });
        }
    } finally {
        abortController = null;
    }
}
