document.addEventListener('DOMContentLoaded', () => {
  // --- DOM ELEMENTS ---
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatStop = document.getElementById('chat-stop');
  const statusMessage = document.getElementById('status-message');
  const chatContainer = document.getElementById('chat-container');
  const nonPdfMessage = document.getElementById('non-pdf-message');

  let isThinking = false;
  let currentUrl = null;

  // --- UI Functions ---
  const addMessage = (content, sender) => {
    const messageElement = document.createElement('div');
    messageElement.classList.add('chat-message', `${sender}-message`);
    const bubble = document.createElement('div');
    bubble.classList.add('bubble');
    bubble.innerHTML = content;
    messageElement.appendChild(bubble);
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return messageElement;
  };

  const setUIState = (state, message = '') => {
    statusMessage.textContent = message;
    if (state === 'loading') {
      chatInput.disabled = true;
      chatSend.disabled = true;
      chatStop.style.display = 'none';
      nonPdfMessage.style.display = 'none';
      chatContainer.style.display = 'flex';
    } else if (state === 'ready') {
      chatInput.disabled = false;
      chatSend.disabled = chatInput.value.trim().length === 0;
      chatSend.style.display = 'inline-flex';
      chatStop.style.display = 'none';
      chatInput.focus();
      isThinking = false;
    } else if (state === 'thinking') {
      chatInput.disabled = true;
      chatSend.style.display = 'none';
      chatStop.style.display = 'inline-flex';
      isThinking = true;
    } else if (state === 'not-pdf') {
        chatContainer.style.display = 'none';
        nonPdfMessage.style.display = 'flex';
        statusMessage.textContent = '';
    }
  };

  // --- Event Handlers ---
  const handleUserMessage = () => {
    const question = chatInput.value.trim();
    if (question && !isThinking && currentUrl) {
      addMessage(question, 'user');
      setUIState('thinking', 'Thinking...');
      isThinking = true;
      chrome.runtime.sendMessage({ type: 'ask-question', url: currentUrl, question: question });
      chatInput.value = '';
      chatSend.disabled = true;
    }
  };

  // --- Message Listener ---
  chrome.runtime.onMessage.addListener((message) => {
    // Initial activation messages from background script
    if (message.type === 'pdf-activated') {
        if (currentUrl !== message.url) {
            currentUrl = message.url;
            chatMessages.innerHTML = '';
            setUIState('loading', 'Checking for existing session...');
            chrome.runtime.sendMessage({ type: 'start-processing', url: currentUrl });
        }
        return;
    }
    if (message.type === 'not-pdf') {
        currentUrl = null;
        setUIState('not-pdf');
        return;
    }

    // All other messages must match the current URL to be processed.
    if (message.url !== currentUrl) {
        return;
    }

    let lastMessageElement;
    switch (message.type) {
      case 'status-update':
        setUIState('loading', message.message);
        break;

      case 'init-chat':
        chatMessages.innerHTML = '';
        message.history.forEach(msg => addMessage(marked.parse(msg.content), msg.role));
        setUIState('ready', 'Ready to chat.');
        break;

      case 'ama-chunk':
        lastMessageElement = chatMessages.lastElementChild;
        if (!lastMessageElement || !lastMessageElement.classList.contains('assistant-message')) {
          lastMessageElement = addMessage('', 'assistant');
          lastMessageElement.querySelector('.bubble')._markdownContent = '';
        }
        const bubble = lastMessageElement.querySelector('.bubble');
        bubble._markdownContent += message.chunk;
        // Only update innerHTML with parsed markdown on completion to prevent duplication
        // For now, just append the raw chunk to avoid re-parsing issues.
        // The full parsing will happen on ama-complete.
        bubble.textContent += message.chunk; // Append raw text
        chatMessages.scrollTop = chatMessages.scrollHeight;
        break;
      
      case 'ama-complete':
        const finalBubble = chatMessages.lastElementChild.querySelector('.bubble');
        finalBubble.innerHTML = marked.parse(finalBubble._markdownContent); // Parse full content once
        setUIState('ready');
        isThinking = false;
        break;

      case 'ama-terminated':
        setUIState('ready', 'Terminated. Ready for a new question.');
        isThinking = false;
        break;

      case 'error':
        addMessage(`Error: ${message.message}`, 'assistant');
        setUIState('ready', 'You can try asking another question.');
        isThinking = false;
        break;
    }
  });

  // --- Input & Button Events ---
  chatSend.addEventListener('click', handleUserMessage);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleUserMessage();
    }
  });

  chatInput.addEventListener('input', () => {
    chatSend.disabled = chatInput.value.trim().length === 0;
  });

  chatStop.addEventListener('click', () => {
    if (isThinking) {
      chrome.runtime.sendMessage({ type: 'terminate-chat', url: currentUrl });
    }
  });

  // --- Initialization ---
  setUIState('loading', 'Initializing...');
  chrome.runtime.sendMessage({ type: 'sidebar-loaded' });
});
