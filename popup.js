// popup.js

// --- HELPER to convert ArrayBuffer to Base64 ---
const arrayBufferToBase64 = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
};

// --- INJECTED SCRIPT 1: The AI Worker (runs in MAIN world) ---
const mainWorldAiWorker = () => {
    if (window.pdfAskletWorkerLoaded) return;
    window.pdfAskletWorkerLoaded = true;
    const sendMessage = (detail) => window.dispatchEvent(new CustomEvent('PDFASKLET_RESPONSE', { detail }));
    window.addEventListener('PDFASKLET_REQUEST', async (event) => {
        console.log("WORKER (Main): Received request. Event detail:", event.detail);
        console.log("WORKER (Main): Type of detail:", typeof event.detail, "Length:", event.detail?.length);
        try {
            // THE FIX 1: The text is now the entire detail object, not a property of it.
            const text = event.detail; 
            
            if (!text || typeof text !== 'string') {
                sendMessage({ status: 'error', data: 'AI worker received empty or invalid text.' });
                return;
            }

            if ('Summarizer' in self && typeof self.Summarizer.availability === 'function') {
                const availability = await self.Summarizer.availability();
                if (availability === 'available' || availability === 'downloadable') {
                    const summarizer = await self.Summarizer.create({
                        monitor(m) { m.addEventListener('downloadprogress', (e) => sendMessage({ status: 'progress', data: e.loaded })); }
                    });
                    sendMessage({ status: 'info', data: 'Model ready. Summarizing...' });
                    const summary = await summarizer.summarize(text);
                    sendMessage({ status: 'success', data: summary, text: text });
                } else {
                    sendMessage({ status: 'error', data: `Model not available. Status: ${availability}` });
                }
            } else {
                 sendMessage({ status: 'error', data: "Summarizer API not found in this context." });
            }
        } catch (error) {
            sendMessage({ status: 'error', data: `AI Processing Failed: ${error.message}` });
        }
    }, false);
};

// --- INJECTED SCRIPT 2: The PDF Orchestrator (runs in ISOLATED world) ---
const isolatedWorldOrchestrator = async (pdfBase64String) => {
    const base64ToArrayBuffer = (base64) => {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    };
    window.addEventListener('PDFASKLET_RESPONSE', (event) => {
        chrome.runtime.sendMessage(event.detail);
    }, false);
    try {
        const pdfjsLibUrl = chrome.runtime.getURL('lib/pdfjs/build/pdf.mjs');
        const pdfjsWorkerUrl = chrome.runtime.getURL('lib/pdfjs/build/pdf.worker.mjs');
        const pdfjsLib = await import(pdfjsLibUrl);
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
        const pdfArrayBuffer = base64ToArrayBuffer(pdfBase64String);
        const loadingTask = pdfjsLib.getDocument(pdfArrayBuffer);
        const pdf = await loadingTask.promise;
        let textContent = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            textContent += (await page.getTextContent()).items.map(item => item.str).join(' ');
        }
        // NEW: Log what we are sending from this side of the bridge
        console.log("ORCHESTRATOR (Isolated): Dispatching text with length:", textContent.length);
        
        // THE FIX 2: Send the text string directly as the detail.
        window.dispatchEvent(new CustomEvent('PDFASKLET_REQUEST', { detail: textContent }));

    } catch (error) {
        chrome.runtime.sendMessage({ status: 'error', data: `PDF Parsing Failed: ${error.message}` });
    }
};

// --- MAIN POPUP LOGIC ---
document.addEventListener('DOMContentLoaded', async () => {
    const statusDiv = document.getElementById('status');
    const progressContainer = document.getElementById('progress-container');
    const progressBarInner = document.getElementById('progress-bar-inner');
    const progressLabel = document.getElementById('progress-label');
    const summaryContainer = document.getElementById('summary-container');
    const summaryContent = document.getElementById('summary-content');
    
    const handleChatIndexing = (text) => {
        if (!text || !statusDiv) return;
        statusDiv.textContent = "Indexing document for chat...";
        const chunks = text.split(/\n\s*\n/).filter(chunk => chunk.trim().length > 10);
        console.log(`Document split into ${chunks.length} chunks.`);
    };

    chrome.runtime.onMessage.addListener((message) => {
        if (message.status === 'success') {
            if (statusDiv) statusDiv.textContent = 'Analysis complete.';
            if (progressContainer) progressContainer.style.display = 'none';
            if (summaryContainer) summaryContainer.style.display = 'block';
            if (summaryContent) summaryContent.textContent = message.data;
            handleChatIndexing(message.text);
        } else if (message.status === 'info') {
            if (statusDiv) statusDiv.textContent = message.data;
        } else if (message.status === 'progress') {
            if (statusDiv) statusDiv.textContent = 'Downloading AI Model...';
            if (progressContainer) progressContainer.style.display = 'block';
            const percent = Math.round(message.data * 100);
            if (progressLabel) progressLabel.textContent = `Downloading AI Model... ${percent}%`;
            if (progressBarInner) progressBarInner.style.width = `${percent}%`;
        } else if (message.status === 'error') {
            if (statusDiv) statusDiv.textContent = 'An error occurred.';
            if (progressContainer) progressContainer.style.display = 'none';
            if (summaryContainer) summaryContainer.style.display = 'block';
            if (summaryContent) summaryContent.textContent = message.data;
        }
    });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
        try {
            if (statusDiv) statusDiv.textContent = 'Setting up AI worker...';
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: mainWorldAiWorker, world: 'MAIN' });
            
            if (statusDiv) statusDiv.textContent = 'Fetching PDF data...';
            const response = await fetch(tab.url);
            const pdfArrayBuffer = await response.arrayBuffer();
            
            if (statusDiv) statusDiv.textContent = 'Encoding data...';
            const pdfBase64String = arrayBufferToBase64(pdfArrayBuffer);
            
            if (statusDiv) statusDiv.textContent = 'Parsing PDF and calling AI...';
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: isolatedWorldOrchestrator, args: [pdfBase64String] });
        } catch (e) {
            if (statusDiv) statusDiv.textContent = 'Fatal Error. See console.';
            if (summaryContainer) summaryContainer.style.display = 'block';
            if (summaryContent) summaryContent.textContent = `Could not run on this page. Error: ${e.message}`;
            console.error("Popup error:", e);
        }
    } else {
        if (statusDiv) statusDiv.textContent = 'Please open a PDF document to begin.';
    }
});