// sidebar.js

let port;

function connect() {
    port = chrome.runtime.connect({ name: 'sidebar' });

    port.onDisconnect.addListener(() => {
        console.log("Sidebar port disconnected.");
        port = null; // Set port to null on disconnection
    });

    // The message listener will be set up in DOMContentLoaded
}

function safePostMessage(message) {
    if (!port) {
        console.log("Port is disconnected, reconnecting...");
        connect();
    }
    port.postMessage(message);
}

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
    console.log(`Setting UI state to: ${state}`, message);
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
            safePostMessage({
              type: 'ask-question',
              from: COMPONENTS.SIDEBAR,
              to: COMPONENTS.OFFSCREEN,
              url: currentUrl,
              question: question // Send question directly, not nested in data
            });
      chatInput.value = '';
      chatSend.disabled = true;
    }
  };

  // --- Message Listener ---
  port.onMessage.addListener((message) => {
    // Only process messages addressed to sidebar
    if (message.to !== COMPONENTS.SIDEBAR) {
      console.log("Sidebar ignoring message not addressed to it:", message);
      return;
    }

    // Initial activation messages from background script
    if (message.type === 'pdf-activated') {
        const url = message.url; // Corrected: read url directly from message
        console.log("Sidebar processing pdf-activated for url:", url, "currentUrl:", currentUrl);
        if (currentUrl !== url) {
            currentUrl = url;
            chatMessages.innerHTML = '';
            setUIState('loading', 'Checking for existing session...');
            console.log("Sidebar sending start-processing message");
            safePostMessage({
              type: 'start-processing',
              from: COMPONENTS.SIDEBAR,
              to: COMPONENTS.BACKGROUND, // Send to background, which will route to offscreen
              url: currentUrl // Send url directly, not nested in data
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
            safePostMessage({
                type: 'request-buffered-response', // New message type for offscreen
                from: COMPONENTS.SIDEBAR,
                to: COMPONENTS.BACKGROUND, // Send to background, which will route to offscreen
                url: currentUrl
            });
            // Re-evaluate UI state based on current session (which offscreen will send via init-chat or status-update)
            // The offscreen document should send an init-chat or status-update message upon receiving 'tab-activated'
            // if it needs to update the sidebar's state. No need to re-trigger start-processing from here.
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
        if (message.message === 'Thinking...') { // Corrected: read message directly
          setUIState('thinking', message.message);
        } else {
          setUIState('loading', message.message); // Corrected: read message directly
        }
        break;

      case 'init-chat':
        chatMessages.innerHTML = '';
        message.history.forEach(msg => addMessage(marked.parse(msg.content), msg.role)); // Corrected: read history directly
        // Restore UI state from session, or default to 'ready' if not present
        setUIState('ready', message.uiState || 'Ready to chat.'); // Corrected: read uiState directly
        break;

      case 'ama-chunk':
        lastMessageElement = chatMessages.lastElementChild;
        if (!lastMessageElement || !lastMessageElement.classList.contains('assistant-message')) {
          lastMessageElement = addMessage('', 'assistant');
          lastMessageElement.querySelector('.bubble')._markdownContent = '';
        }
        const bubble = lastMessageElement.querySelector('.bubble');
        bubble._markdownContent += message.chunk; // Corrected: read chunk directly
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
        addMessage(`Error: ${message.message}`, 'assistant'); // Corrected: read message directly
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
      safePostMessage({
        type: 'terminate-chat',
        from: COMPONENTS.SIDEBAR,
        to: COMPONENTS.BACKGROUND, // Send to background, which will route to offscreen
        url: currentUrl // Send url directly, not nested in data
      });
    }
  });

  // --- Initialization ---
  setUIState('loading', 'Initializing Context...');
  safePostMessage({
    type: 'sidebar-loaded',
    from: COMPONENTS.SIDEBAR,
    to: COMPONENTS.BACKGROUND
  });
});

connect(); // Initial connection
