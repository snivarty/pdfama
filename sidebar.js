document.addEventListener('DOMContentLoaded', () => {
  // --- DOM ELEMENTS ---
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const statusMessage = document.getElementById('status-message');

  // --- UI Functions ---
  const addMessage = (content, sender) => {
    const messageElement = document.createElement('div');
    messageElement.classList.add('chat-message', `${sender}-message`);
    const bubble = document.createElement('p');
    bubble.classList.add('bubble');
    bubble.textContent = content;
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
      chrome.runtime.sendMessage({ type: 'ask-question', question: question });
      chatInput.value = '';
    }
  };

  chatSend.addEventListener('click', handleUserMessage);
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleUserMessage();
  });

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
        if (!lastMessageElement || !lastMessageElement.classList.contains('bot-message')) {
          lastMessageElement = addMessage('', 'bot');
        }
        lastMessageElement.querySelector('.bubble').textContent += message.chunk;
        chatMessages.scrollTop = chatMessages.scrollHeight;
        break;
      
      case 'ama-complete':
        setUIState('ready', 'Ready to chat.');
        break;

      case 'error':
        addMessage(`Error: ${message.message}`, 'bot');
        setUIState('ready', 'You can try asking another question.');
        break;
    }
  });

  // --- Initialization ---
  setUIState('loading', 'Loading...');
  chrome.runtime.sendMessage({ type: 'sidebar-loaded' });
});