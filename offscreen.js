// Establish connection to background
const port = chrome.runtime.connect({ name: 'offscreen' });

const COMPONENTS = {
  SIDEBAR: 'sidebar',
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen'
};

import { VectorDB } from '/lib/vectoridb/index.js';
import { pipeline, env } from '/lib/transformers/transformers.min.js';
import { getSession, saveSession, VECTORS_STORE } from '/lib/sessiondb/index.js';

// --- CONFIGURATION ---
const CHUNK_SIZE = 1024;
const CHUNK_OVERLAP = 100;
const TOKEN_LIMIT = 32000;
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const VECTOR_PROPERTY_NAME = 'embedding';

// --- STATE ---
let abortController = null;
let isSidebarActive = true; // Assume active initially
let bufferedResponse = '';
let bufferedUiState = '';

// --- ENVIRONMENT SETUP ---
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


// --- HELPERS ---
function getStoreName(url) {
  // This will create a unique store name based on the URL.
  // It will strip any special characters from the URL.
  return `vdb_${url.replace(/[^a-zA-Z0-9]/g, "")}`;
}

// --- RAG PIPELINE ---
class RagPipeline {
    constructor(url, text, vectorStore) {
        this.url = url;
        this.text = text;
        this.vectorStore = vectorStore;
        this.embedder = null;
    }

    async init() {
        this.embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);


        port.postMessage({
          type: 'status-update',
          from: COMPONENTS.OFFSCREEN,
          to: COMPONENTS.SIDEBAR,
          url: this.url,
          data: { message: 'Chunking document...' }
        });
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: CHUNK_SIZE,
            chunkOverlap: CHUNK_OVERLAP,
        });
        const chunks = await splitter.splitText(this.text);

        port.postMessage({
          type: 'status-update',
          from: COMPONENTS.OFFSCREEN,
          to: COMPONENTS.SIDEBAR,
          url: this.url,
          data: { message: 'Generating embeddings (this may take a while)...' }
        });
        console.log('Starting embedding of', chunks.length, 'chunks');
        let processedChunks = 0;
        for (const chunk of chunks) {
            console.log('Embedding chunk', processedChunks + 1, 'of', chunks.length);
            const embedding = await this.embedder(chunk, { pooling: 'mean', normalize: true });
            await this.vectorStore.insert({
                pdfUrl: this.url,
                text: chunk,
                [VECTOR_PROPERTY_NAME]: Array.from(embedding.data)
            });
            processedChunks++;
            if (processedChunks % 10 === 0) {
                port.postMessage({
                  type: 'status-update',
                  from: COMPONENTS.OFFSCREEN,
                  to: COMPONENTS.SIDEBAR,
                  url: this.url,
                  data: { message: `Embedding... (${processedChunks}/${chunks.length})` }
                });
            }
        }
    }

    async retrieve(query) {
        if (!this.embedder) {
            this.embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);
        }
        const queryEmbedding = await this.embedder(query, { pooling: 'mean', normalize: true });
        const results = await this.vectorStore.query(queryEmbedding.data, { limit: 3 });
        return results.map(r => r.object.text).join('\n\n---\n\n');
    }
}

// Need to track currentUrl in offscreen.js for tab activation/deactivation logic
let currentUrl = null;

// --- MESSAGE HANDLING ---
port.onMessage.addListener(async (message) => {
    // Only process messages addressed to offscreen
    if (message.to !== COMPONENTS.OFFSCREEN) {
      console.log("Offscreen ignoring message not addressed to it:", message);
      return;
    }

    console.log("Offscreen processing", message.type, "message");
    switch (message.type) {
        case 'start-processing':
            await processPdfAndInitAi(message.data.url);
            break;
        case 'ask-question':
            await handleAskQuestion(message.data.url, message.data.question);
            break;
        case 'terminate-chat':
            console.log("Offscreen terminating chat");
            if (abortController) {
                abortController.abort();
                abortController = null;
            }
            break;
        case 'tab-activated':
            console.log("Offscreen received tab-activated for url:", message.url);
            // Initiate PDF processing and RAG pipeline for the activated tab
            await processPdfAndInitAi(message.url);
            // After processing, handle buffered responses if sidebar becomes active
            if (message.url === currentUrl) {
                isSidebarActive = true;
                if (bufferedResponse) {
                    port.postMessage({
                        type: 'ama-chunk',
                        from: COMPONENTS.OFFSCREEN,
                        to: COMPONENTS.SIDEBAR,
                        url: message.url,
                        data: { chunk: bufferedResponse }
                    });
                    bufferedResponse = '';
                }
                if (bufferedUiState) {
                    port.postMessage({
                        type: 'status-update',
                        from: COMPONENTS.OFFSCREEN,
                        to: COMPONENTS.SIDEBAR,
                        url: message.url,
                        data: { message: bufferedUiState }
                    });
                    bufferedUiState = '';
                }
                port.postMessage({
                    type: 'ama-complete-buffered', // Use a specific type for buffered completion
                    from: COMPONENTS.OFFSCREEN,
                    to: COMPONENTS.SIDEBAR,
                    url: message.url
                });
            }
            break;
        case 'tab-deactivated':
            console.log("Offscreen received tab-deactivated for url:", message.url);
            if (message.url === currentUrl) {
                isSidebarActive = false;
            }
            break;
        case 'request-buffered-response':
            console.log("Offscreen received request-buffered-response for url:", message.url);
            if (message.url === currentUrl) {
                if (bufferedResponse) {
                    port.postMessage({
                        type: 'ama-chunk',
                        from: COMPONENTS.OFFSCREEN,
                        to: COMPONENTS.SIDEBAR,
                        url: message.url,
                        data: { chunk: bufferedResponse }
                    });
                    bufferedResponse = '';
                }
                if (bufferedUiState) {
                    port.postMessage({
                        type: 'status-update',
                        from: COMPONENTS.OFFSCREEN,
                        to: COMPONENTS.SIDEBAR,
                        url: message.url,
                        data: { message: bufferedUiState }
                    });
                    bufferedUiState = '';
                }
                port.postMessage({
                    type: 'ama-complete-buffered',
                    from: COMPONENTS.OFFSCREEN,
                    to: COMPONENTS.SIDEBAR,
                    url: message.url
                });
            }
            break;
    }
});


async function processPdfAndInitAi(url) {
    currentUrl = url; // Set currentUrl when processing starts
    try {
        // Always re-process the PDF and initialize RAG for new RAG-able docs.
        // This ensures the pipeline runs even if a session with text exists,
        // addressing the "stuck on initiating" issue.
        let session = await getSession(url);
        if (!session) {
            session = { url, text: '', chatHistory: [], isRAG: false, uiState: 'Processing PDF...' };
        } else {
            // If a session exists, clear its text and RAG status to force re-processing
            session.text = '';
            session.isRAG = false;
            session.uiState = 'Processing PDF...';
        }

        await saveSession(session);

        port.postMessage({
          type: 'status-update',
          from: COMPONENTS.OFFSCREEN,
          to: COMPONENTS.SIDEBAR,
          url,
          data: { message: session.uiState }
        });
        const { getDocument, GlobalWorkerOptions } = await import(chrome.runtime.getURL('lib/pdfjs/build/pdf.mjs'));
        GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/build/pdfjs-worker-loader.js');

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
        const pdfData = await response.arrayBuffer();
        if (pdfData.byteLength === 0) throw new Error("Fetched PDF is empty.");

        const typedArray = new Uint8Array(pdfData);
        const pdf = await getDocument({ data: typedArray }).promise;
        let textContent = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            textContent += (await (await pdf.getPage(i)).getTextContent()).items.map(item => item.str).join(' ');
        }

        const isRAG = textContent.length > TOKEN_LIMIT;
        session.text = textContent;
        session.isRAG = isRAG;
        session.uiState = 'Ready to chat.'; // Default after processing
        await saveSession(session);

        if (isRAG) {
            console.log("Document exceeds token limit, initializing RAG pipeline.");
            session.uiState = 'Initializing RAG pipeline...';
            await saveSession(session);
            console.log("Updating sidebar with RAG initialization status.");
            port.postMessage({
              type: 'status-update',
              from: COMPONENTS.OFFSCREEN,
              to: COMPONENTS.SIDEBAR,
              url,
              data: { message: session.uiState }
            });
            console.log("Initializing RAG pipeline for URL:", url);
            const storeName = getStoreName(url);
            const vectorStore = new VectorDB({
                dbName: 'pdfAMA',
                storeName,
                vectorPath: VECTOR_PROPERTY_NAME,
                vectorDimensions: 384
            });
            const rag = new RagPipeline(url, session.text, vectorStore);
            console.log("Starting RAG init...");
            await rag.init(); // Trigger chunking and embedding here
            console.log("RAG init complete.");
            session.uiState = 'Ready to chat.'; // After RAG init, it's ready
            await saveSession(session);
        }

        port.postMessage({
          type: 'status-update',
          from: COMPONENTS.OFFSCREEN,
          to: COMPONENTS.SIDEBAR,
          url,
          data: { message: 'Ready to chat.' }
        });
        port.postMessage({
          type: 'init-chat',
          from: COMPONENTS.OFFSCREEN,
          to: COMPONENTS.SIDEBAR,
          url,
          data: { history: [] }
        });

    } catch (error) {
        console.error('[pdfAMA Engine Room]: CRITICAL ERROR:', error);
        port.postMessage({
          type: 'error',
          from: COMPONENTS.OFFSCREEN,
          to: COMPONENTS.SIDEBAR,
          url,
          data: { message: error.message }
        });
    }
}

async function handleAskQuestion(url, question) {
    abortController = new AbortController();
    const { signal } = abortController;

    try {
        const session = await getSession(url);
        if (!session) throw new Error('Session not found.');

        session.chatHistory.push({ role: 'user', content: question });

        if (!self.LanguageModel) throw new Error("LanguageModel API not available.");
        const availability = await self.LanguageModel.availability({expectedOutputs: [{ type: "text", languages: ["en"] }]});
        if (availability !== 'available') throw new Error(`AI model not available: ${availability}`);

        let stream;
        if (session.text.length > TOKEN_LIMIT) {
            // --- RAG PATH ---
            port.postMessage({
              type: 'status-update',
              from: COMPONENTS.OFFSCREEN,
              to: COMPONENTS.SIDEBAR,
              url,
              data: { message: 'Thinking...' }
            });
            const storeName = getStoreName(url);
            const vectorStore = new VectorDB({
                dbName: 'pdfAMA',
                storeName,
                vectorPath: VECTOR_PROPERTY_NAME,
                vectorDimensions: 384
            });
            const rag = new RagPipeline(url, session.text, vectorStore);
            await rag.init();
            const context = await rag.retrieve(question);
            const augmentedPrompt = `Based on the following text, answer the question: "${question}"\n\n---\n\n${context}`;

            const ragSession = await self.LanguageModel.create({
                 initialPrompts: [{ role: 'user', content: `You are a helpful assistant. Answer based *only* on the provided text. Here is the text: ${context}\n\nMy question is: ${question}` }],
                 expectedInputs: [{ type: "text", languages: ["en"] }],
                 expectedOutputs: [{ type: "text", languages: ["en"] }]
            });
            stream = await ragSession.promptStreaming(augmentedPrompt, { signal });

        } else {
            // --- DIRECT PATH ---
            const initialUserPrompt = `You are a helpful assistant. Answer based *only* on the provided text. Here is the text: ${session.text}\n\nMy question is: ${question}`;
            const prompts = [
                { role: 'user', content: initialUserPrompt },
                ...session.chatHistory.slice(0, -1).map(msg => ({
                    ...msg,
                    role: msg.role === 'model' ? 'assistant' : msg.role // Ensure all previous 'model' roles are 'assistant'
                }))
            ];
            const chatSession = await self.LanguageModel.create({
                initialPrompts: prompts,
                expectedInputs: [{ type: "text", languages: ["en"] }],
                expectedOutputs: [{ type: "text", languages: ["en"] }]
            });
            stream = await chatSession.promptStreaming(question, { signal });
        }

        let fullResponse = '';
        for await (const chunk of stream) {
            if (signal.aborted) return;
            if (isSidebarActive) {
                port.postMessage({
                  type: 'ama-chunk',
                  from: COMPONENTS.OFFSCREEN,
                  to: COMPONENTS.SIDEBAR,
                  url,
                  data: { chunk }
                });
            } else {
                bufferedResponse += chunk;
            }
            fullResponse += chunk;
        }

        session.chatHistory.push({ role: 'assistant', content: fullResponse });
        await saveSession(session);

        if (isSidebarActive) {
            port.postMessage({
              type: 'ama-complete',
              from: COMPONENTS.OFFSCREEN,
              to: COMPONENTS.SIDEBAR,
              url
            });
        } else {
            // If sidebar is not active, send a special message to indicate completion
            // and that the response is buffered.
            bufferedUiState = 'Response ready (buffered).';
            // No message sent here, it will be sent when tab is activated
        }


    } catch (error) {
        if (error.name === 'AbortError' || (signal && signal.aborted)) {
            port.postMessage({
              type: 'ama-terminated',
              from: COMPONENTS.OFFSCREEN,
              to: COMPONENTS.SIDEBAR,
              url
            });
        } else {
            console.error('[pdfAMA Engine Room]: AI Query Error:', error);
            port.postMessage({
              type: 'error',
              from: COMPONENTS.OFFSCREEN,
              to: COMPONENTS.SIDEBAR,
              url,
              data: { message: `AI Error: ${error.message}` }
            });
        }
    } finally {
        abortController = null;
    }
}
