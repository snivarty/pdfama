// background.js

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creating;

async function hasOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
}

async function setupOffscreenDocument(path) {
  if (navigator.storage && navigator.storage.persist) {
    await navigator.storage.persist();
  }
  if (await hasOffscreenDocument()) return;
  if (creating) {
    await creating;
  } else {
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

async function notifySidebarOfActiveTab() {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || !activeTab.url) {
            chrome.runtime.sendMessage({ type: 'not-pdf' });
            return;
        }
        const isPdf = activeTab.url.toLowerCase().endsWith('.pdf') || activeTab.mimeType === 'application/pdf';
        if (isPdf) {
            await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
            chrome.runtime.sendMessage({ type: 'pdf-activated', url: activeTab.url });
        } else {
            chrome.runtime.sendMessage({ type: 'not-pdf' });
        }
    } catch (e) {
        console.warn("Could not notify sidebar of tab change:", e);
    }
}

chrome.runtime.onMessage.addListener(async (message, sender) => {
    // This is the entry point when the sidebar opens.
    if (message.type === 'sidebar-loaded') {
        notifySidebarOfActiveTab();
        return;
    }

    // Relay all other messages between sidebar and offscreen.
    // The sender check prevents infinite loops.
    if (sender.url?.includes('sidebar.html')) {
        await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
        chrome.runtime.sendMessage(message);
    } else if (sender.url?.includes('offscreen.html')) {
        chrome.runtime.sendMessage(message);
    }
});

chrome.tabs.onActivated.addListener(notifySidebarOfActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.status === 'complete') {
        notifySidebarOfActiveTab();
    }
});
