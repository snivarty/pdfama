// background.js

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const COMPONENTS = {
  SIDEBAR: 'sidebar',
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen'
};

// Maintain direct connections to components
let sidebarPort = null;
let activePdfTab = { tabId: null, url: null }; // Track the currently active PDF tab

let sidebarReadyResolve = null;
let sidebarReadyPromise = new Promise(resolve => {
  sidebarReadyResolve = resolve;
});

chrome.runtime.onConnect.addListener((port) => {
  console.log('Background connected to:', port.name);

  switch (port.name) {
    case COMPONENTS.SIDEBAR:
      sidebarPort = port;
      console.log('Sidebar connection established');
      if (sidebarReadyResolve) {
        sidebarReadyResolve();
        sidebarReadyResolve = null;
      }
      port.onDisconnect.addListener(() => {
        console.log('Sidebar disconnected');
        sidebarPort = null;
        sidebarReadyPromise = new Promise(resolve => {
          sidebarReadyResolve = resolve;
        });
      });
      port.onMessage.addListener((message) => {
        console.log("Background received message from sidebar:", message);
        if (message.to === COMPONENTS.BACKGROUND) {
          // Handle internal messages from sidebar
          if (message.type === 'sidebar-loaded') {
            console.log("Background processing sidebar-loaded. Calling notifySidebarOfActiveTab.");
            notifySidebarOfActiveTab();
            console.log("notifySidebarOfActiveTab called after sidebar-loaded.");
          }
        } else {
          // Messages not addressed to BACKGROUND are intended for other components (e.g., OFFSCREEN)
          // Route these messages explicitly.
          if (message.to === COMPONENTS.OFFSCREEN) {
            console.log("[pdfAMA Background]: Routing message from sidebar to offscreen (via port.onMessage.addListener):", message);
            chrome.runtime.sendMessage(message);
          } else {
            console.warn("[pdfAMA Background]: Unhandled message from sidebar:", message);
          }
        }
      });
      break;
  }
});

// For offscreen.js, we will use chrome.runtime.sendMessage instead of MessagePorts.
// So, no offscreenPort or related promises are needed here.

let creating;

function getComponentNameFromUrl(url) {
  if (url?.includes('sidebar.html')) return COMPONENTS.SIDEBAR;
  if (url?.includes('offscreen.html')) return COMPONENTS.OFFSCREEN;
  return COMPONENTS.BACKGROUND;
}

async function hasOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
}

async function setupOffscreenDocument(path) {
  if (navigator.storage && navigator.storage.persist) {
    await navigator.storage.persist();
  }

  if (await hasOffscreenDocument()) {
    return; // Offscreen document already exists
  }

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
        const [currentActiveTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!currentActiveTab || !currentActiveTab.url) {
            // If no active tab or URL, and there was a previous PDF tab, deactivate it
            if (activePdfTab.url) {
                console.log(`No active tab or URL. Deactivating previous PDF tab: ${activePdfTab.url}`);
                chrome.runtime.sendMessage({
                    type: 'tab-deactivated',
                    from: COMPONENTS.BACKGROUND,
                    to: COMPONENTS.OFFSCREEN,
                    url: activePdfTab.url
                });
                activePdfTab = { tabId: null, url: null };
            }
            if (sidebarPort) sidebarPort.postMessage({
              type: 'not-pdf',
              from: COMPONENTS.BACKGROUND,
              to: COMPONENTS.SIDEBAR
            });
            return;
        }

        const isCurrentTabPdf = currentActiveTab.url.toLowerCase().endsWith('.pdf') ||
                               (currentActiveTab.mimeType && currentActiveTab.mimeType === 'application/pdf') ||
                               (currentActiveTab.url.includes('.pdf'));

        // Check if the active PDF tab has changed or if a non-PDF tab became active
        if (activePdfTab.tabId !== currentActiveTab.id || activePdfTab.url !== currentActiveTab.url) {
            // If there was a previous active PDF tab, send deactivate signal
            if (activePdfTab.url) {
                console.log(`Tab changed. Deactivating previous PDF tab: ${activePdfTab.url}`);
                chrome.runtime.sendMessage({
                    type: 'tab-deactivated',
                    from: COMPONENTS.BACKGROUND,
                    to: COMPONENTS.OFFSCREEN,
                    url: activePdfTab.url
                });
            }

            if (isCurrentTabPdf) {
                // New active tab is a PDF
                console.log(`New active tab is PDF: ${currentActiveTab.url}. Activating.`);
                await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH); // Ensure offscreen document is ready

                if (!sidebarPort) {
                    console.log("Waiting for sidebarPort to connect...");
                    await sidebarReadyPromise;
                }

                if (sidebarPort) {
                    console.log("Sidebar port is connected. Sending pdf-activated and tab-activated messages.");
                    sidebarPort.postMessage({
                      type: 'pdf-activated',
                      from: COMPONENTS.BACKGROUND,
                      to: COMPONENTS.SIDEBAR,
                      url: currentActiveTab.url // Send url directly, not nested in data
                    });
                    chrome.runtime.sendMessage({
                        type: 'tab-activated',
                        from: COMPONENTS.BACKGROUND,
                        to: COMPONENTS.OFFSCREEN,
                        url: currentActiveTab.url
                    });
                    activePdfTab = { tabId: currentActiveTab.id, url: currentActiveTab.url };
                } else {
                    console.warn("Failed to establish sidebar port after setup, skipping PDF activation. SidebarPort:", sidebarPort ? "connected" : "not connected");
                    activePdfTab = { tabId: null, url: null }; // Reset if activation fails
                }
            } else {
                // New active tab is NOT a PDF
                console.log(`New active tab is NOT PDF: ${currentActiveTab.url}.`);
                if (sidebarPort) sidebarPort.postMessage({
                  type: 'not-pdf',
                  from: COMPONENTS.BACKGROUND,
                  to: COMPONENTS.SIDEBAR
                });
                activePdfTab = { tabId: null, url: null };
            }
        } else if (isCurrentTabPdf && !activePdfTab.url) {
            // This case handles initial load where activePdfTab might be null but current tab is PDF
            console.log(`Initial PDF tab activation: ${currentActiveTab.url}.`);
            await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);

            if (!sidebarPort) {
                console.log("Waiting for sidebarPort to connect during initial activation...");
                await sidebarReadyPromise;
            }

            if (sidebarPort) {
                console.log("Sidebar port is connected during initial activation. Sending pdf-activated and tab-activated messages.");
                sidebarPort.postMessage({
                  type: 'pdf-activated',
                  from: COMPONENTS.BACKGROUND,
                  to: COMPONENTS.SIDEBAR,
                  url: currentActiveTab.url // Send url directly, not nested in data
                });
                chrome.runtime.sendMessage({
                    type: 'tab-activated',
                    from: COMPONENTS.BACKGROUND,
                    to: COMPONENTS.OFFSCREEN,
                    url: currentActiveTab.url
                });
                activePdfTab = { tabId: currentActiveTab.id, url: currentActiveTab.url };
            } else {
                console.warn("Failed to establish sidebar port during initial PDF activation. SidebarPort:", sidebarPort ? "connected" : "not connected");
                activePdfTab = { tabId: null, url: null };
            }
        }
    } catch (e) {
        console.warn("Could not notify sidebar of tab change:", e);
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Messages from offscreen to sidebar are routed here
    if (message.from === COMPONENTS.OFFSCREEN && message.to === COMPONENTS.SIDEBAR) {
        if (sidebarPort) {
            sidebarPort.postMessage(message);
            return false; // Message handled
        } else {
            console.warn("Sidebar port not connected, cannot route message from offscreen:", message);
            return false;
        }
    }
    // Messages from sidebar to offscreen are routed here (via background)
    if (message.from === COMPONENTS.SIDEBAR && message.to === COMPONENTS.OFFSCREEN) {
        console.log("[pdfAMA Background]: Routing message from sidebar to offscreen:", message);
        chrome.runtime.sendMessage(message);
        return false; // Message handled
    }
    // Other messages can be processed by the default routeMessage function if needed
    // For now, we assume all offscreen -> sidebar and sidebar -> offscreen messages are handled above.
    return false; // Default to not processing internally unless explicitly handled
});



chrome.tabs.onActivated.addListener(notifySidebarOfActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.status === 'complete') {
        notifySidebarOfActiveTab();
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (activePdfTab.tabId === tabId) {
        console.log(`PDF tab ${tabId} removed. Deactivating.`);
        chrome.runtime.sendMessage({
            type: 'tab-deactivated',
            from: COMPONENTS.BACKGROUND,
            to: COMPONENTS.OFFSCREEN,
            url: activePdfTab.url
        });
        activePdfTab = { tabId: null, url: null };
    }
});
