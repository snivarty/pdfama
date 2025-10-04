// offscreen.js

let chatSession;
let abortController = null;

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
    GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/build/pdf.worker.mjs');
    
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

    // Step 2: Initialize the AI
    if (!self.LanguageModel) throw new Error("LanguageModel API not available.");
    const availability = await self.LanguageModel.availability();
    if (availability !== 'available') throw new Error(`AI model not available: ${availability}`);
    
    chatSession = await self.LanguageModel.create({
      initialPrompts: [
        { role: 'system', content: 'You are a helpful assistant. Answer based *only* on the provided text.' },
        { role: 'user', content: textContent }
      ]
    });
    
    chrome.runtime.sendMessage({ type: 'status-update', message: 'Ready to chat.' });
    // Send an empty history to signal the UI is ready
    chrome.runtime.sendMessage({ type: 'init-chat', history: [] });

  } catch (error) {
    console.error('[pdfAMA Engine Room]: CRITICAL ERROR:', error);
    chrome.runtime.sendMessage({ type: 'error', message: error.message });
  }
}

async function handleAskQuestion(question) {
    console.log("[pdfAMA Engine Room]: Received question:", question);
    if (!chatSession) {
        chrome.runtime.sendMessage({ type: 'error', message: 'AI session not ready.' });
        return;
    }
      // NEW: create abort controller
    abortController = new AbortController();
    const { signal } = abortController;
    try {
        const stream = await chatSession.promptStreaming(question, { signal });
        for await (const chunk of stream) {
            if (signal.aborted) {
                console.log("[pdfAMA Engine Room]: Streaming aborted.");
                return;
            }
            chrome.runtime.sendMessage({ type: 'ama-chunk', chunk: chunk });
            console.log("[pdfAMA Engine Room]: Sent chunk:", chunk);
        }
        chrome.runtime.sendMessage({ type: 'ama-complete' });
    } catch (error) {
        if (error.name === 'AbortError' || signal.aborted) {
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