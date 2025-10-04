document.addEventListener('DOMContentLoaded', () => {
  // --- DOM ELEMENTS ---
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const statusMessage = document.getElementById('status-message');

  let chatHistory = [];

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

  const setUIState = (state, message) => {
    statusMessage.textContent = message;
    if (state === 'loading') {
      chatInput.disabled = true;
      chatSend.disabled = true;
    } else if (state === 'ready') {
      chatInput.disabled = false;
      chatSend.disabled = false;
      chatInput.focus();
    } else if (state === 'thinking') {
      chatInput.disabled = true;
      chatSend.disabled = true;
    }
  };

  // --- Event Handlers ---
  const handleUserMessage = () => {
    const question = chatInput.value.trim();
    if (question) {
      addMessage(question, 'user');
      setUIState('thinking', 'Thinking...');
      //console.log("[pdfAMA Sidebar]: Sending question to background:", question);
      chrome.runtime.sendMessage({ type: 'ask-question', question: question });
      chatInput.value = '';
      chatSend.disabled = true;
    }
  };

  chatSend.addEventListener('click', handleUserMessage);
  /* chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleUserMessage();
  }); */

  // --- Message Listener from Service Worker ---
  chrome.runtime.onMessage.addListener((message) => {
    let lastMessageElement;
    switch (message.type) {
      case 'status-update':
        setUIState('loading', message.message);
        break;
      
      case 'ai-initialized':
        setUIState('ready', 'Ready to chat.');
        break;

      case 'init-chat':
        chatMessages.innerHTML = '';
        message.history.forEach(msg => addMessage(msg.content, msg.role));
        setUIState('ready', 'Ready to chat.');
        break;

      case 'ama-chunk':
        lastMessageElement = chatMessages.lastElementChild;
        // If there's no last message or it's not a bot message, create a new one.
        if (!lastMessageElement || !lastMessageElement.classList.contains('bot-message')) {
          lastMessageElement = addMessage('', 'bot');
          // Add a temporary property to store the raw markdown
          lastMessageElement.querySelector('.bubble')._markdownContent = '';
        }
        const bubble = lastMessageElement.querySelector('.bubble');
        // Append the raw markdown chunk to our stored property
        bubble._markdownContent += message.chunk;
        // Render the complete markdown string into the bubble as HTML
        bubble.innerHTML = marked.parse(bubble._markdownContent);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        break;
      
      case 'ama-complete':
        const finalBubble = chatMessages.lastElementChild.querySelector('.bubble');
        // Do one final render to catch any trailing markdown formatting
        finalBubble.innerHTML = marked.parse(finalBubble._markdownContent);
        // Add the raw markdown to our history for consistency
        chatHistory.push({ role: 'bot', content: finalBubble._markdownContent });
        setUIState('ready');
        break;

      case 'error':
        addMessage(`Error: ${message.message}`, 'bot');
        setUIState('ready', 'You can try asking another question.');
        break;
    }
  });

// Enter/Shift+Enter handling
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();   // prevent newline
    chatSend.click();     // trigger send
  }
});

chatInput.addEventListener('input', () => {
  chatSend.disabled = chatInput.value.trim().length === 0;
});

  // --- Initialization ---
  setUIState('loading', 'Loading...');
  chrome.runtime.sendMessage({ type: 'sidebar-loaded' });
});