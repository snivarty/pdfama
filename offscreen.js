// offscreen.js

import { VectorDB } from '/lib/vectoridb/index.js';
import { pipeline, env } from '/lib/transformers/transformers.min.js';

// --- CONFIGURATION ---
const CHUNK_SIZE = 1024;
const CHUNK_OVERLAP = 100;
const TOKEN_LIMIT = 32000; // A conservative token limit for Gemini Nano
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

// VectorDB specific configuration
const DB_PREFIX = 'pdfAMA_'; // Prefix for all PDF databases
const OBJECT_STORE_NAME = 'pdfVectors';
const VECTOR_PROPERTY_NAME = 'embedding'; // The property name within the stored object that holds the vector

// --- STATE ---
let chatSession;
let directChatContext = null; // Stores PDF content for direct (non-RAG) chat sessions
let abortController = null;
let ragPipeline = null; // Will hold the RAG pipeline for large documents

// --- ENVIRONMENT SETUP ---
// Skip local model checks for a streamlined setup.
env.allowLocalModels = false;

// --- UTILITY FUNCTIONS ---
/**
 * Generates a simple, stable hash from a string.
 * Used to create unique database names from PDF URLs.
 * @param {string} str The input string (e.g., PDF URL).
 * @returns {string} A hash string.
 */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36); // Convert to base36 string
}

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
    constructor(text, url, existingVectorStore = null) {
        this.text = text;
        this.url = url; // Store the URL
        this.vectorStore = existingVectorStore; // Can be pre-initialized
        this.embedder = null;
    }

    /**
     * Initializes the pipeline by creating embeddings and the vector store.
     */
    async init() {
        chrome.runtime.sendMessage({ type: 'status-update', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: this.url, message: 'Initializing AI model...' });
        this.embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);

        if (!this.vectorStore) { // Only create if not provided
            chrome.runtime.sendMessage({ type: 'status-update', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: this.url, message: 'Creating vector store...' });
            this.vectorStore = new VectorDB({
                dbName: DB_PREFIX + hashString(this.text), // Use a hash of the text for the DB name
                objectStore: OBJECT_STORE_NAME,
                vectorPath: VECTOR_PROPERTY_NAME,
                vectorDimensions: 384 // Dimensions for all-MiniLM-L6-v2
            });

            chrome.runtime.sendMessage({ type: 'status-update', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: this.url, message: 'Chunking document...' });
            const splitter = new RecursiveCharacterTextSplitter({
                chunkSize: CHUNK_SIZE,
                chunkOverlap: CHUNK_OVERLAP,
            });
            const chunks = await splitter.splitText(this.text);

            chrome.runtime.sendMessage({ type: 'status-update', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: this.url, message: 'Generating embeddings (this may take a while)...' });
            let processedChunks = 0;
            for (const chunk of chunks) {
                const embedding = await this.embedder(chunk, { pooling: 'mean', normalize: true });
                await this.vectorStore.insert({
                    text: chunk,
                    [VECTOR_PROPERTY_NAME]: Array.from(embedding.data)
                });
                processedChunks++;
                if (processedChunks % 10 === 0) {
                     chrome.runtime.sendMessage({ type: 'status-update', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: this.url, message: `Embedding... (${processedChunks}/${chunks.length})` });
                }
            }
        } else {
            chrome.runtime.sendMessage({ type: 'status-update', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: this.url, message: 'Re-using existing embeddings.' });
        }
    }

    /**
     * Retrieves relevant context from the vector store based on a query.
     * @param {string} query - The user's question.
     * @returns {Promise<string>} The retrieved context.
     */
    async retrieve(query) {
        if (!this.embedder) { // Ensure embedder is initialized for retrieval
            this.embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);
        }
        const queryEmbedding = await this.embedder(query, { pooling: 'mean', normalize: true });
        const results = await this.vectorStore.query(queryEmbedding.data, { limit: 3 });
        return results.map(r => r.object.text).join('\n\n---\n\n');
    }
}


const COMPONENTS = {
  SIDEBAR: 'sidebar',
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen'
};

// Listen for commands from the Butler (background.js)
chrome.runtime.onMessage.addListener(async (message) => {
  console.log("[pdfAMA Engine Room]: Message received in offscreen.js listener:", message);
  console.log("[pdfAMA Engine Room]: message.to:", message.to, "COMPONENTS.OFFSCREEN:", COMPONENTS.OFFSCREEN, "message.to === COMPONENTS.OFFSCREEN:", message.to === COMPONENTS.OFFSCREEN, "message.type:", message.type);

  if (message.to !== COMPONENTS.OFFSCREEN) {
    console.log("[pdfAMA Engine Room]: Message not addressed to offscreen, ignoring.");
    return; // Ignore messages not addressed to this offscreen document
  }

  if (message.type === 'start-processing') {
    console.log("[pdfAMA Engine Room]: Processing start-processing message.");
    await processPdfAndInitAi(message.url);
  } else if (message.type === 'ask-question') {
    console.log("[pdfAMA Engine Room]: Processing ask-question message. Question:", message.question, "for url:", message.url);
    await handleAskQuestion(message.question, message.url);
  } else if (message.type === 'terminate-chat') {      // NEW
    console.log("[pdfAMA Engine Room]: Processing terminate-chat message. Termination requested.");
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  } else if (message.type === 'tab-deactivated') {
    // Handle tab deactivation if necessary, though offscreen.js doesn't directly manage active tabs
    console.log("[pdfAMA Engine Room]: Received tab-deactivated for url:", message.url);
  } else if (message.type === 'tab-activated') {
    // Handle tab activation if necessary
    console.log("[pdfAMA Engine Room]: Received tab-activated for url:", message.url);
    await processPdfAndInitAi(message.url); // Re-process or ensure session is active
  } else if (message.type === 'request-buffered-response') {
    // Handle request for buffered response if necessary
    console.log("[pdfAMA Engine Room]: Received request-buffered-response for url:", message.url);
    // In this setup, offscreen.js doesn't buffer responses for sidebar directly.
    // The sidebar should request the current state from background, which then gets it from offscreen.
  }
});

async function processPdfAndInitAi(url) {
  try {
    chrome.runtime.sendMessage({ type: 'status-update', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: url, message: 'Processing PDF...' });
    
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
        const dbName = DB_PREFIX + hashString(url); // Use URL hash for DB name
        let existingVectorStore = null;

        try {
            // Attempt to open existing DB
            const tempStore = new VectorDB({
                dbName: dbName,
                objectStore: OBJECT_STORE_NAME,
                vectorPath: VECTOR_PROPERTY_NAME,
                vectorDimensions: 384 // Must match the dimensions used during creation
            });
            // Check if the object store exists and has data
            const db = await tempStore._db; // Access the internal promise for the DB
            const transaction = db.transaction([OBJECT_STORE_NAME], "readonly");
            const store = transaction.objectStore(OBJECT_STORE_NAME);
            const count = await new Promise((resolve, reject) => {
                const req = store.count();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            if (count > 0) {
                existingVectorStore = tempStore;
                console.log(`[pdfAMA Engine Room]: Re-using existing VectorDB for ${url}`);
            } else {
                console.log(`[pdfAMA Engine Room]: No existing embeddings found for ${url}. Creating new.`);
            }
        } catch (e) {
            console.warn(`[pdfAMA Engine Room]: Could not open existing VectorDB for ${url}: ${e.message}. Creating new.`);
        }

        ragPipeline = new RagPipeline(textContent, url, existingVectorStore);
        await ragPipeline.init();
    } else {
        // --- Direct Path for Small Documents ---
        ragPipeline = null; // Ensure RAG is not used
        directChatContext = textContent; // Store the PDF content for later use (for potential re-use or debugging)
        chatSession = await self.LanguageModel.create({
            initialPrompts: [
                { role: 'system', content: 'You are a helpful assistant. Answer based *only* on the provided text.' },
                { role: 'user', content: textContent } // Include PDF content as an initial user prompt
            ],
            expectedInputs: [{ type: "text", languages: ["en"] }],
            expectedOutputs: [{ type: "text", languages: ["en"] }]
        });
    }
    
    chrome.runtime.sendMessage({ type: 'status-update', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: url, message: 'Ready to chat.' });
    chrome.runtime.sendMessage({ type: 'init-chat', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: url, history: [] });

  } catch (error) {
    console.error('[pdfAMA Engine Room]: CRITICAL ERROR:', error);
    chrome.runtime.sendMessage({ type: 'error', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: url, message: error.message });
  }
}

async function handleAskQuestion(question, url) { // Pass url to handleAskQuestion
    console.log("[pdfAMA Engine Room]: Received question:", question);
    abortController = new AbortController();
    const { signal } = abortController;

    try {
        let stream;
        if (ragPipeline) {
            // --- RAG Query ---
            chrome.runtime.sendMessage({ type: 'status-update', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: url, message: 'Searching document...' });
            const context = await ragPipeline.retrieve(question);
            const augmentedPrompt = `Based on the following text, answer the question: "${question}"\n\n---\n\n${context}`;
            
            // For RAG, we create a new session for each query
            const ragSession = await self.LanguageModel.create({
                 initialPrompts: [{ role: 'system', content: 'You are a helpful assistant. Answer based *only* on the provided text.' }],
                 expectedInputs: [{ type: "text", languages: ["en"] }],
                 expectedOutputs: [{ type: "text", languages: ["en"] }]
            });
            stream = await ragSession.promptStreaming(augmentedPrompt, { signal });

        } else if (chatSession) { // Only proceed if chatSession is available
            // --- Direct Query ---
            // The chatSession already has the system prompt and PDF content from initialization.
            // Just pass the user's question to continue the conversation.
            stream = await chatSession.promptStreaming(question, { signal });
        } else {
            throw new Error('AI session not ready.');
        }

        for await (const chunk of stream) {
            if (signal.aborted) {
                console.log("[pdfAMA Engine Room]: Streaming aborted.");
                return;
            }
            chrome.runtime.sendMessage({ type: 'ama-chunk', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: url, chunk: chunk });
        }
        chrome.runtime.sendMessage({ type: 'ama-complete', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: url });

    } catch (error) {
        if (error.name === 'AbortError' || (signal && signal.aborted)) {
            console.log("[pdfAMA Engine Room]: Chat was aborted by user.");
            chrome.runtime.sendMessage({ type: 'ama-terminated', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: url });
        } else {
            console.error('[pdfAMA Engine Room]: AI Query Error:', error);
            chrome.runtime.sendMessage({ type: 'error', from: COMPONENTS.OFFSCREEN, to: COMPONENTS.SIDEBAR, url: url, message: `AI Error: ${error.message}` });
        }
    } finally {
        abortController = null;
    }
}
