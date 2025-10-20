// offscreen.js

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


// --- RAG PIPELINE ---
class RagPipeline {
    constructor(url, text, vectorStore) {
        this.url = url;
        this.text = text;
        this.vectorStore = vectorStore;
        this.embedder = null;
    }

    async init() {
        chrome.runtime.sendMessage({ type: 'status-update', message: 'Initializing AI model...', url: this.url });
        this.embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);

        const count = await this.vectorStore.count();
        if (count > 0) {
            chrome.runtime.sendMessage({ type: 'status-update', message: 'Re-using existing embeddings.', url: this.url });
            return;
        }

        chrome.runtime.sendMessage({ type: 'status-update', message: 'Chunking document...', url: this.url });
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: CHUNK_SIZE,
            chunkOverlap: CHUNK_OVERLAP,
        });
        const chunks = await splitter.splitText(this.text);

        chrome.runtime.sendMessage({ type: 'status-update', message: 'Generating embeddings (this may take a while)...', url: this.url });
        let processedChunks = 0;
        for (const chunk of chunks) {
            const embedding = await this.embedder(chunk, { pooling: 'mean', normalize: true });
            await this.vectorStore.insert({
                pdfUrl: this.url,
                text: chunk,
                [VECTOR_PROPERTY_NAME]: Array.from(embedding.data)
            });
            processedChunks++;
            if (processedChunks % 10 === 0) {
                chrome.runtime.sendMessage({ type: 'status-update', message: `Embedding... (${processedChunks}/${chunks.length})`, url: this.url });
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

// --- MESSAGE HANDLING ---
chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'start-processing') {
        await processPdfAndInitAi(message.url);
    } else if (message.type === 'ask-question') {
        await handleAskQuestion(message.url, message.question);
    } else if (message.type === 'terminate-chat') {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    }
});

async function processPdfAndInitAi(url) {
    try {
        let session = await getSession(url);
        if (session && session.text) {
            // No backward compatibility needed, assume 'assistant' role is correct
            // for existing sessions.
            chrome.runtime.sendMessage({ type: 'status-update', message: 'Session found. Loading chat...', url });
            chrome.runtime.sendMessage({ type: 'init-chat', history: session.chatHistory, url });
            return;
        }

        chrome.runtime.sendMessage({ type: 'status-update', message: 'Processing PDF...', url });
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

        session = { url, text: textContent, chatHistory: [] };
        await saveSession(session);

        chrome.runtime.sendMessage({ type: 'status-update', message: 'Ready to chat.', url });
        chrome.runtime.sendMessage({ type: 'init-chat', history: [], url });

    } catch (error) {
        console.error('[pdfAMA Engine Room]: CRITICAL ERROR:', error);
        chrome.runtime.sendMessage({ type: 'error', message: error.message, url });
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
            chrome.runtime.sendMessage({ type: 'status-update', message: 'Searching document...', url });
            const vectorStore = new VectorDB({
                dbName: 'pdfAMA',
                objectStore: VECTORS_STORE,
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
            chrome.runtime.sendMessage({ type: 'ama-chunk', chunk, url });
            fullResponse += chunk;
        }

        session.chatHistory.push({ role: 'assistant', content: fullResponse });
        await saveSession(session);
        chrome.runtime.sendMessage({ type: 'ama-complete', url });

    } catch (error) {
        if (error.name === 'AbortError' || (signal && signal.aborted)) {
            chrome.runtime.sendMessage({ type: 'ama-terminated', url });
        } else {
            console.error('[pdfAMA Engine Room]: AI Query Error:', error);
            chrome.runtime.sendMessage({ type: 'error', message: `AI Error: ${error.message}`, url });
        }
    } finally {
        abortController = null;
    }
}
