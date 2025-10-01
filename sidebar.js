document.addEventListener('DOMContentLoaded', () => {
    // --- DOM ELEMENTS ---
    const tabs = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    const headlineContent = document.getElementById('headline-content');
    const tldrContent = document.getElementById('tldr-content');
    const teaserContent = document.getElementById('teaser-content');
    const keyPointsContent = document.getElementById('key-points-content');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');
    const statusDiv = document.getElementById('status');
    const progressContainer = document.getElementById('progress-container');
    const progressBarInner = document.getElementById('progress-bar-inner');
    const progressLabel = document.getElementById('progress-label');

    // --- STATE ---
    let pdfText = '';
    let chatHistory = [];
    
    // --- TAB HANDLING ---
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            tabContents.forEach(content => content.classList.toggle('active', content.id === tab.dataset.tab));
        });
    });

    // --- INJECTED SCRIPTS ---
    const mainWorldAiWorker = () => {
        if (window.pdfAmaWorkerLoaded) return;
        window.pdfAmaWorkerLoaded = true;

        const sendMessage = (detail) => window.dispatchEvent(new CustomEvent('PDFAMA_RESPONSE', { detail }));

        window.addEventListener('PDFAMA_REQUEST', async (event) => {
            const { type, payload } = event.detail;
            try {
                if (!payload.text || payload.text.length < 10) {
                     sendMessage({ status: 'error', data: 'AI Worker received empty or invalid text.' });
                     return;
                }
                const text = payload.text;
                //console.log("text is", text);

                if (type === 'summarize') {
                    if ('Summarizer' in self) {
                        const availability = await self.Summarizer.availability();
                        console.log("availability is", availability);
                        if (availability === 'available' || availability === 'downloadable') {
                            
                            // Sequential calls to prevent race conditions
                            console.log("Creating headline summarizer...");
                            const headlineSummarizer = await self.Summarizer.create({ monitor: (m) => m.addEventListener('downloadprogress', (e) => sendMessage({ status: 'progress', data: e.loaded})), 'type': 'headline', 'format': 'markdown', 'length': 'short'});
                            console.log("Headline summarizer created.");

                            console.log("Creating TLDR summarizer...");
                            const tldrSummarizer = await self.Summarizer.create({ 'type': 'tldr', 'format': 'markdown', 'length': 'medium'});
                            console.log("TLDR summarizer created.");

                            console.log("Creating Teaser summarizer...");
                            const teaserSummarizer = await self.Summarizer.create({ 'type': 'teaser', 'format': 'markdown', 'length': 'medium'});
                            console.log("teaser summarizer created.");                            

                            console.log("Creating Key Points summarizer...");
                            const keyPointsSummarizer = await self.Summarizer.create({ 'type': 'key-points', 'format': 'markdown', 'length': 'long'});
                            console.log("Key Points summarizer created.");

                            const headlinePromise = headlineSummarizer.summarize(text).then(headline => {
                                console.log("headline is", headline);
                                sendMessage({ status: 'headline_success', data: headline, text: text });
                            }).catch(e => sendMessage({ status: 'error', data: `Headline summarization failed: ${e.message}` }));

                            const tldrPromise = tldrSummarizer.summarize(text).then(tldr => {
                                console.log("tldr is", tldr);
                                sendMessage({ status: 'tldr_success', data: tldr });
                            }).catch(e => sendMessage({ status: 'error', data: `TLDR summarization failed: ${e.message}` }));

                            const teaserPromise = teaserSummarizer.summarize(text).then(teaser => {
                                console.log("teaser is", tldr);
                                sendMessage({ status: 'teaser_success', data: teaser });
                            }).catch(e => sendMessage({ status: 'error', data: `Teaser summarization failed: ${e.message}` }));


                            const keyPointsPromise = keyPointsSummarizer.summarize(text).then(keyPoints => {
                                console.log("keyPoints is", keyPoints);
                                sendMessage({ status: 'keypoints_success', data: keyPoints });
                            }).catch(e => sendMessage({ status: 'error', data: `Key points summarization failed: ${e.message}` }));

                            await Promise.all([headlinePromise, tldrPromise, keyPointsPromise]);

                        } else { sendMessage({ status: 'error', data: `Model not available. Status: ${availability}` }); }
                    } else { sendMessage({ status: 'error', data: "Summarizer API not found." }); }
                } else if (type === 'ama') {
                    // Placeholder for now to prevent errors
                    sendMessage({ status: 'error', data: 'Chat functionality is being fixed. Please try again soon.' });
                }
            } catch (error) { sendMessage({ status: 'error', data: `AI Processing Failed: ${error.message}` }); }
        });
    };

    const dispatchRequestToWorker = (request) => {
        window.dispatchEvent(new CustomEvent('PDFAMA_REQUEST', { detail: request }));
    };

    const isolatedWorldListener = () => {
        window.addEventListener('PDFAMA_RESPONSE', (event) => {
            chrome.runtime.sendMessage(event.detail);
        });
    };

    // --- UI & MESSAGE HANDLING ---
    const addMessage = (message, sender) => {
        const messageElement = document.createElement('div');
        messageElement.classList.add('chat-message', `${sender}-message`);
        const bubble = document.createElement('p');
        bubble.classList.add('bubble');
        bubble.textContent = message;
        messageElement.appendChild(bubble);
        if (chatMessages) { chatMessages.appendChild(messageElement); chatMessages.scrollTop = chatMessages.scrollHeight; }
    };
    
    chrome.runtime.onMessage.addListener((message) => {
        if (message.text) pdfText = message.text;
        switch (message.status) {
            case 'headline_success': if (headlineContent) headlineContent.textContent = message.data; break;
            case 'tldr_success': if (tldrContent) tldrContent.textContent = message.data; break;
            case 'teaser_success': if (teaserContent) teaserContent.textContent = message.data; break;
            case 'keypoints_success': if (keyPointsContent) { keyPointsContent.innerHTML = ''; message.data.split('\n').filter(p => p.trim().length > 0).forEach(point => { const li = document.createElement('li'); li.textContent = point.replace(/^- /, '').trim(); keyPointsContent.appendChild(li); }); } break;
            case 'ama_chunk': let lastMessage = chatMessages.lastElementChild; if (!lastMessage || !lastMessage.classList.contains('bot-message')) { addMessage('', 'bot'); lastMessage = chatMessages.lastElementChild; } lastMessage.querySelector('.bubble').textContent += message.data; chatMessages.scrollTop = chatMessages.scrollHeight; break;
            case 'ama_complete': const finalAnswer = chatMessages.lastElementChild.querySelector('.bubble').textContent; chatHistory.push({ role: 'bot', content: finalAnswer }); break;
            case 'progress': if (progressContainer) progressContainer.style.display = 'block'; const percent = Math.round(message.data * 100); if (progressLabel) progressLabel.textContent = `Downloading AI Model... ${percent}%`; if (progressBarInner) progressBarInner.style.width = `${percent}%`; break;
            case 'error': if (statusDiv) statusDiv.textContent = `Error: ${message.data}`; addMessage(`Error: ${message.data}`, 'bot'); break;
            case 'info': if (statusDiv) statusDiv.textContent = message.data; break;
        }
    });

    const handleUserMessage = async () => {
        if (!chatInput || !pdfText) {
            addMessage("Error: The PDF has not been fully processed yet.", "bot");
            return;
        }
        const question = chatInput.value.trim();
        if (question) {
            addMessage(question, 'user');
            chatHistory.push({ role: 'user', content: question });
            chatInput.value = '';
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const request = { type: 'ama', payload: { history: chatHistory, question: question, text: pdfText } };
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: dispatchRequestToWorker,
                args: [request],
                world: 'MAIN'
            });
        }
    };

    if (chatSend) chatSend.addEventListener('click', handleUserMessage);
    if (chatInput) chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUserMessage();
    });

    // --- INITIALIZATION ---
    const init = async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const isPdf = tab && tab.url && (tab.url.endsWith('.pdf') || (tab.url.startsWith('file:') && tab.title.endsWith('.pdf')));
        if (isPdf) {
            try {
                if (statusDiv) statusDiv.textContent = 'Setting up listeners...';
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: mainWorldAiWorker, world: 'MAIN' });
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: isolatedWorldListener });

                if (statusDiv) statusDiv.textContent = 'Parsing PDF...';
                const response = await fetch(tab.url);
                const pdfArrayBuffer = await response.arrayBuffer();
                const pdfjsLibUrl = chrome.runtime.getURL('lib/pdfjs/build/pdf.mjs');
                const pdfjsWorkerUrl = chrome.runtime.getURL('lib/pdfjs/build/pdf.worker.mjs');
                const { getDocument, GlobalWorkerOptions } = await import(pdfjsLibUrl);
                GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
                const pdf = await getDocument(pdfArrayBuffer).promise;
                let textContent = '';
                for (let i = 1; i <= pdf.numPages; i++) {
                    textContent += (await (await pdf.getPage(i)).getTextContent()).items.map(item => item.str).join(' ');
                }
                pdfText = textContent;

                if (statusDiv) statusDiv.textContent = 'Generating summaries...';
                const request = { type: 'summarize', payload: { text: pdfText } };
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: dispatchRequestToWorker,
                    args: [request],
                    world: 'MAIN'
                });

            } catch (e) {
                console.error("Initialization error:", e);
                if (statusDiv) statusDiv.textContent = `Fatal Error: ${e.message}`;
            }
        } else {
            if (statusDiv) statusDiv.textContent = 'Open a PDF to begin.';
        }
    };

    init();
});