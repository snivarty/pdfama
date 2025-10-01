if (document.contentType === 'application/pdf' || window.location.href.endsWith('.pdf')) {
  chrome.runtime.sendMessage({ type: 'pdf-detected' });
}
