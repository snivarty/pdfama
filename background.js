// background.js

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const COMPONENTS = {
  SIDEBAR: 'sidebar',
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen'
};

// Maintain direct connections to components
let sidebarPort = null;
let offscreenPort = null;
let activePdfTab = { tabId: null, url: null }; // Track the currently active PDF tab

chrome.runtime.onConnect.addListener((port) => {
  console.log('Background connected to:', port.name);

  switch (port.name) {
    case COMPONENTS.SIDEBAR:
      sidebarPort = port;
      console.log('Sidebar connection established');
      port.onDisconnect.addListener(() => {
        console.log('Sidebar disconnected');
        sidebarPort = null;
      });
      port.onMessage.addListener((message) => {
        console.log("Background received message from sidebar:", message);
        if (message.to === COMPONENTS.BACKGROUND) {
          // Handle internal messages from sidebar
          if (message.type === 'sidebar-loaded') {
            console.log("Background processing sidebar-loaded");
            notifySidebarOfActiveTab();
          }
        } else {
          routeMessage(message);
        }
      });
      break;
    case COMPONENTS.OFFSCREEN:
      offscreenPort = port;
      console.log('Offscreen connection established');
      if (offscreenReadyResolve) {
        offscreenReadyResolve(); // Resolve the promise when offscreen connects
        offscreenReadyResolve = null; // Clear the resolver
      }
      port.onDisconnect.addListener(() => {
        console.log('Offscreen disconnected');
        offscreenPort = null;
        offscreenReadyPromise = null; // Reset promise on disconnect
      });
      port.onMessage.addListener((message) => {
        console.log("Background received message from offscreen:", message);
        routeMessage(message); // Offscreen messages are always routed to sidebar
      });
      break;
  }
});

let creating;
let offscreenReadyPromise = null;
let offscreenReadyResolve = null;

// Ensure offscreenReadyPromise is always a valid promise that resolves when offscreenPort is available
function ensureOffscreenReadyPromise() {
  if (!offscreenReadyPromise) {
    offscreenReadyPromise = new Promise(resolve => {
      offscreenReadyResolve = resolve;
      if (offscreenPort) { // If already connected, resolve immediately
        offscreenReadyResolve();
        offscreenReadyResolve = null; // Clear resolver after use
      }
    });
  }
  return offscreenReadyPromise;
}

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

  // Always ensure a promise exists
  const currentOffscreenReadyPromise = ensureOffscreenReadyPromise();

  if (await hasOffscreenDocument()) {
    // If offscreen document already exists, just wait for the port to be ready
    return currentOffscreenReadyPromise;
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
  return currentOffscreenReadyPromise;
}

async function notifySidebarOfActiveTab() {
    try {
        const [currentActiveTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!currentActiveTab || !currentActiveTab.url) {
            // If no active tab or URL, and there was a previous PDF tab, deactivate it
            if (activePdfTab.url) {
                console.log(`No active tab or URL. Deactivating previous PDF tab: ${activePdfTab.url}`);
                if (offscreenPort) {
                    offscreenPort.postMessage({
                        type: 'tab-deactivated',
                        from: COMPONENTS.BACKGROUND,
                        to: COMPONENTS.OFFSCREEN,
                        url: activePdfTab.url
                    });
                }
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
                if (offscreenPort) {
                    offscreenPort.postMessage({
                        type: 'tab-deactivated',
                        from: COMPONENTS.BACKGROUND,
                        to: COMPONENTS.OFFSCREEN,
                        url: activePdfTab.url
                    });
                }
            }

            if (isCurrentTabPdf) {
                // New active tab is a PDF
                console.log(`New active tab is PDF: ${currentActiveTab.url}. Activating.`);
                await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);

                if (offscreenPort && sidebarPort) {
                    sidebarPort.postMessage({
                      type: 'pdf-activated',
                      from: COMPONENTS.BACKGROUND,
                      to: COMPONENTS.SIDEBAR,
                      data: { url: currentActiveTab.url }
                    });
                    offscreenPort.postMessage({
                        type: 'tab-activated',
                        from: COMPONENTS.BACKGROUND,
                        to: COMPONENTS.OFFSCREEN,
                        url: currentActiveTab.url
                    });
                    activePdfTab = { tabId: currentActiveTab.id, url: currentActiveTab.url };
                } else {
                    console.warn("Failed to establish offscreen connection or sidebar port after setup, skipping PDF activation.");
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

            if (offscreenPort && sidebarPort) {
                sidebarPort.postMessage({
                  type: 'pdf-activated',
                  from: COMPONENTS.BACKGROUND,
                  to: COMPONENTS.SIDEBAR,
                  data: { url: currentActiveTab.url }
                });
                offscreenPort.postMessage({
                    type: 'tab-activated',
                    from: COMPONENTS.BACKGROUND,
                    to: COMPONENTS.OFFSCREEN,
                    url: currentActiveTab.url
                });
                activePdfTab = { tabId: currentActiveTab.id, url: currentActiveTab.url };
            } else {
                console.warn("Failed to establish offscreen connection or sidebar port during initial PDF activation.");
                activePdfTab = { tabId: null, url: null };
            }
        }
    } catch (e) {
        console.warn("Could not notify sidebar of tab change:", e);
    }
}

function routeMessage(message) {
  // Route based on 'to' field using direct ports
  switch (message.to) {
    case COMPONENTS.SIDEBAR:
      if (sidebarPort) {
        console.log("Routing message to sidebar");
        sidebarPort.postMessage(message);
        return false;
      } else {
        console.warn("Sidebar port not connected");
        return false;
      }
    case COMPONENTS.OFFSCREEN:
      if (offscreenPort) {
        console.log("Routing message to offscreen");
        offscreenPort.postMessage(message);
        return false;
      } else {
        console.warn("Offscreen port not connected");
        return false;
      }
    case COMPONENTS.BACKGROUND:
      return true; // Process internally
    default:
      console.warn(`Unknown recipient: ${message.to}`);
      return false;
  }
}

// The chrome.runtime.onMessage listener is no longer needed as all communication is now port-based.
// It is kept here for historical context during the refactoring process.
// chrome.runtime.onMessage.addListener(async (message, sender) => {
//   console.log("Background received legacy message:", message, "from", sender);

//     // Check if this is the pdf-detected message from content script
//     if (message.type === 'pdf-detected' && !message.to) {
//       console.log("Background received pdf-detected from content script, but ignoring - PDF detection handled by tab queries");
//       return;
//     }

//     // All other messages must be structured now - reject legacy format
//     if (!message.to) {
//       console.error("Rejected legacy message without 'to' field:", message, "from:", sender.url);
//       return;
//     }

//     // Handle internal messages first
//     if (message.type === 'sidebar-loaded' && message.from === COMPONENTS.SIDEBAR && message.to === COMPONENTS.BACKGROUND) {
//         console.log("Background processing sidebar-loaded");
//         notifySidebarOfActiveTab();
//         return;
//     }

//     // Route all other messages
//     console.log("Background routing message:", message);
//     const shouldProcessInternally = routeMessage(message);
//     if (!shouldProcessInternally) {
//       console.log("Background routed message successfully");
//     } else {
//       console.log("Background processed message internally");
//     }
// });

chrome.tabs.onActivated.addListener(notifySidebarOfActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.status === 'complete') {
        notifySidebarOfActiveTab();
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (activePdfTab.tabId === tabId) {
        console.log(`PDF tab ${tabId} removed. Deactivating.`);
        if (offscreenPort) {
            offscreenPort.postMessage({
                type: 'tab-deactivated',
                from: COMPONENTS.BACKGROUND,
                to: COMPONENTS.OFFSCREEN,
                url: activePdfTab.url
            });
        }
        activePdfTab = { tabId: null, url: null };
    }
});
