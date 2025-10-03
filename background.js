// background.js

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creating; // A promise to prevent race conditions when creating the offscreen document.

async function hasOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
}

async function setupOffscreenDocument(path) {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (creating) {
    await creating;
  } else {
    // --- THE TYPO FIX ---
    // The reason must be one of the officially sanctioned values. 'DOM_PARSER' is the correct choice.
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: ['DOM_PARSER'],
      justification: 'To run PDF parsing and AI workloads.',
    });
    try {
      await creating;
    } finally {
      creating = null;
    }
  }
}

// The listener remains async, which is the correct and stable pattern.
chrome.runtime.onMessage.addListener(async (message, sender) => {
  // Relay messages from the Engine Room (offscreen) to the Sidebar
  if (['status-update', 'error', 'ama-chunk', 'ama-complete', 'init-chat'].includes(message.type)) {
    chrome.runtime.sendMessage(message);
    return;
  }
  
  // All other messages require the engine room to be running.
  try {
    await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
    
    if (message.type === 'sidebar-loaded') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && (tab.url.startsWith('http') || tab.url.startsWith('file'))) {
         chrome.runtime.sendMessage({ type: 'start-processing', url: tab.url });
      } else {
         chrome.runtime.sendMessage({ type: 'error', message: 'Cannot process this page. Please open a PDF from a web or local file address.' });
      }
    } else if (message.type === 'ask-question') {
      // Forward the question directly to the engine room.
      chrome.runtime.sendMessage(message);
    }
  } catch (error) {
     console.error("[pdfAMA Doorman]: CRITICAL ERROR setting up Engine Room:", error);
     chrome.runtime.sendMessage({ type: 'error', message: `Failed to start: ${error.message}`});
  }
});