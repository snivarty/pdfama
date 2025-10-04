document.addEventListener('DOMContentLoaded', () => {
  // --- DOM ELEMENTS ---
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatStop = document.getElementById('chat-stop');
  const statusMessage = document.getElementById('status-message');

  let chatHistory = [];
  let isThinking = false;

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
      chatStop.style.display = 'none';
    } else if (state === 'ready') {
      chatInput.disabled = false;
      chatSend.disabled = chatInput.value.trim().length === 0; // only enable if content
      chatSend.style.display = 'inline-flex';
      chatStop.style.display = 'none';
      chatInput.focus();
      isThinking = false;
    } else if (state === 'thinking') {
      chatInput.disabled = true;
      chatSend.style.display = 'none';
      chatStop.style.display = 'inline-flex';
      isThinking = true;
    }
  };

  // --- Event Handlers ---
  const handleUserMessage = () => {
    const question = chatInput.value.trim();
    if (question && !isThinking) {
      addMessage(question, 'user');
      setUIState('thinking', 'Thinking...');
      isThinking = true;
      chrome.runtime.sendMessage({ type: 'ask-question', question: question });
      chatInput.value = '';
      chatSend.disabled = true;
    } else if (isThinking) {
      chrome.runtime.sendMessage({ type: 'terminate-chat' });
      setUIState('ready', 'Terminated. Ready for a new question.');
      isThinking = false;
    }
  };

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
          lastMessageElement.querySelector('.bubble')._markdownContent = '';
        }
        const bubble = lastMessageElement.querySelector('.bubble');
        bubble._markdownContent += message.chunk;
        bubble.innerHTML = marked.parse(bubble._markdownContent);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        break;
      
      case 'ama-complete':
        const finalBubble = chatMessages.lastElementChild.querySelector('.bubble');
        finalBubble.innerHTML = marked.parse(finalBubble._markdownContent);
        chatHistory.push({ role: 'bot', content: finalBubble._markdownContent });
        setUIState('ready');
        isThinking = false;
        break;

      case 'ama-terminated':
        console.log("[pdfAMA]: Chat was terminated by user.");
        setUIState('ready', 'Terminated. Ready for a new question.');
        isThinking = false;
        break;

      case 'error':
        addMessage(`Error: ${message.message}`, 'bot');
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
      chrome.runtime.sendMessage({ type: 'terminate-chat' });
      setUIState('ready', 'Terminated. Ready for a new question.');
      isThinking = false;
    }
  });

  // --- Initialization ---
  setUIState('loading', 'Loading...');
  chrome.runtime.sendMessage({ type: 'sidebar-loaded' });
});
