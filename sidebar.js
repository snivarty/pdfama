// Establish connection to background
const port = chrome.runtime.connect({ name: 'sidebar' });

const COMPONENTS = {
  SIDEBAR: 'sidebar',
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen'
};

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
      port.postMessage({
        type: 'ask-question',
        from: COMPONENTS.SIDEBAR,
        to: COMPONENTS.OFFSCREEN,
        url: currentUrl,
        data: { question: question, url: currentUrl }
      });
      chatInput.value = '';
      chatSend.disabled = true;
    }
  };

  // --- Message Listener ---
  port.onMessage.addListener((message) => {
    console.log("Sidebar received message:", message);

    // Initial activation messages from background script
    if (message.type === 'pdf-activated') {
        const url = message.data.url;
        console.log("Sidebar processing pdf-activated for url:", url, "currentUrl:", currentUrl);
        if (currentUrl !== url) {
            currentUrl = url;
            chatMessages.innerHTML = '';
            setUIState('loading', 'Checking for existing session...');
            console.log("Sidebar sending start-processing message");
            port.postMessage({
              type: 'start-processing',
              from: COMPONENTS.SIDEBAR,
              to: COMPONENTS.OFFSCREEN,
              url: currentUrl,
              data: { url: currentUrl }
            });
        }
        return;
    }
    if (message.type === 'not-pdf') {
        console.log("Sidebar setting non-pdf state");
        currentUrl = null;
        setUIState('not-pdf');
        return;
    }
    if (message.type === 'tab-deactivated') {
        console.log("Sidebar received tab-deactivated for url:", message.url);
        if (message.url === currentUrl) {
            // Keep chat input disabled, show status that processing is in background
            setUIState('loading', 'Generating response in background...');
            // Keep chatStop visible if it was thinking
            if (isThinking) {
                chatStop.style.display = 'inline-flex';
            }
        }
        return;
    }
    if (message.type === 'tab-activated') {
        console.log("Sidebar received tab-activated for url:", message.url);
        if (message.url === currentUrl) {
            // Request offscreen to send buffered response if any
            port.postMessage({
                type: 'request-buffered-response', // New message type for offscreen
                from: COMPONENTS.SIDEBAR,
                to: COMPONENTS.OFFSCREEN,
                url: currentUrl
            });
            // Re-evaluate UI state based on current session (which offscreen will send via init-chat or status-update)
            port.postMessage({
              type: 'start-processing', // Re-trigger processing to get latest state
              from: COMPONENTS.SIDEBAR,
              to: COMPONENTS.OFFSCREEN,
              url: currentUrl,
              data: { url: currentUrl }
            });
        }
        return;
    }

    // All other messages must match the current URL to be processed
    if (message.url !== currentUrl) {
        console.log("Sidebar ignoring message for wrong URL:", message);
        return;
    }

    console.log("Sidebar processing", message.type, "message");
    let lastMessageElement;
    switch (message.type) {
      case 'status-update':
        if (message.data.message === 'Thinking...') {
          setUIState('thinking', message.data.message);
        } else {
          setUIState('loading', message.data.message);
        }
        break;

      case 'init-chat':
        chatMessages.innerHTML = '';
        message.data.history.forEach(msg => addMessage(marked.parse(msg.content), msg.role));
        // Restore UI state from session, or default to 'ready' if not present
        setUIState('ready', message.data.uiState || 'Ready to chat.');
        break;

      case 'ama-chunk':
        lastMessageElement = chatMessages.lastElementChild;
        if (!lastMessageElement || !lastMessageElement.classList.contains('assistant-message')) {
          lastMessageElement = addMessage('', 'assistant');
          lastMessageElement.querySelector('.bubble')._markdownContent = '';
        }
        const bubble = lastMessageElement.querySelector('.bubble');
        bubble._markdownContent += message.data.chunk;
        bubble.innerHTML = marked.parse(bubble._markdownContent); // Parse and render accumulated content
        chatMessages.scrollTop = chatMessages.scrollHeight;
        break;

      case 'ama-complete':
        const finalBubble = chatMessages.lastElementChild.querySelector('.bubble');
        finalBubble.innerHTML = marked.parse(finalBubble._markdownContent); // Parse full content once
        setUIState('ready', 'Ready to chat.'); // Restore the "Ready to chat." message
        isThinking = false;
        break;

      case 'ama-complete-buffered':
        // When a buffered response is completed and the tab is reactivated,
        // offscreen sends the full response via ama-chunk and then ama-complete-buffered.
        // The ama-chunk handler already adds the content, so we just need to finalize UI.
        setUIState('ready', 'Ready to chat.');
        isThinking = false;
        break;

      case 'ama-terminated':
        setUIState('ready', 'Terminated. Ready for a new question.');
        isThinking = false;
        break;

      case 'error':
        addMessage(`Error: ${message.data.message}`, 'assistant');
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
      port.postMessage({
        type: 'terminate-chat',
        from: COMPONENTS.SIDEBAR,
        to: COMPONENTS.OFFSCREEN,
        url: currentUrl,
        data: { url: currentUrl }
      });
    }
  });

  // --- Initialization ---
  setUIState('loading', 'Initializing Context...');
  port.postMessage({
    type: 'sidebar-loaded',
    from: COMPONENTS.SIDEBAR,
    to: COMPONENTS.BACKGROUND
  });
});
