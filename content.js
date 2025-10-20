// The background script now handles PDF detection via chrome.tabs.query,
// so this content script message is no longer needed.
// if (document.contentType === 'application/pdf' || window.location.href.endsWith('.pdf')) {
//   chrome.runtime.sendMessage({ type: 'pdf-detected' });
// }
