// background.js

// When the extension is installed, create the context menu item.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.create({
    id: 'open-sidebar',
    title: 'Open pdfAMA',
    contexts: ['all']
  });
});

// When the user clicks the context menu, open the side panel.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-sidebar') {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// Listen for the content script to detect a PDF.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'pdf-detected') {
    // A PDF was detected. Enable the side panel for this tab.
    chrome.sidePanel.setOptions({
      tabId: sender.tab.id,
      path: 'sidebar.html',
      enabled: true
    });
  }
});