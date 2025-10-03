# UI Update
We'll add a chat input field and a message display area to our popup.html.
# Vector Database
We will integrate LanceDB WASM into our popup.js to store and search the document's content.
# Indexing
We will fully implement the handleChatIndexing function. It will take the full PDF text, chunk it into paragraphs, get an embedding for each chunk from a Gemini API, and store them in LanceDB.
# Chat Logic
When you type a question, we will get an embedding for your question, use LanceDB to find the most relevant text chunks from the PDF, and then send a carefully crafted prompt to the Gemini API to generate an answer based on that context.

# Roadmap
Here is a high-level roadmap of the changes we can work on together:
1. Architectural Refactoring for Robustness and Scalability
The current architecture mixes UI logic, state management, and heavy processing within the side panel script. We can significantly improve this.
Centralize Logic in the Service Worker (background.js): We will move the core business logic—PDF parsing, AI model interaction, and state management (like chat history)—into the background service worker. This decouples the UI from the processing, making the side panel faster, more responsive, and less prone to errors if it's closed and reopened.
Embrace Asynchronous Message Passing: We'll refactor the communication between the side panel and the background script to rely exclusively on chrome.runtime.sendMessage and chrome.runtime.onMessage. This is a more standard and robust pattern than injecting and dispatching events directly into the page's world.
Consolidate the User Interface: The code contains both a sidebar.js and a popup.js. To create a more focused user experience, we should deprecate the popup and make the side panel the single, primary interface for the extension, as intended in your manifest.json.
2. Performance and AI Optimization
To handle large documents gracefully and use the AI model more efficiently, we can implement several optimizations.
Efficient PDF Processing: Instead of parsing the entire PDF at once in the main thread, we can process it in the background service worker. For very large files, we can even leverage an Offscreen Document to avoid bogging down the service worker.
Smarter AI Context Management (RAG): Sending the full PDF text with every AMA query is inefficient and token-heavy. We will implement a basic Retrieval-Augmented Generation (RAG) system. This involves chunking the document text in the background and, for each user question, finding and sending only the most relevant chunks to the AI. This will dramatically improve response speed and relevance.
Unified AI Model: Instead of creating four separate Summarizer instances, we can use a single LanguageModel session with specific prompts to generate the headline, TL;DR, teaser, and key points. This reduces the overhead of loading and initializing multiple model instances.
3. User Experience (UX) Overhaul
A great tool needs a great interface. We can make the extension more intuitive and pleasant to use.
Improve the Summary Display: We'll replace the plain text display with a more structured layout. We can use placeholders or "skeleton" loaders that appear while the summaries are being generated and then populate them as the data arrives.
Enhance the AMA Chat Interface: We'll upgrade the chat to include features like rendering the AI's markdown responses (for lists, bolding, etc.), adding a "copy to clipboard" button for answers, and providing visual feedback while the AI is "typing."
Persistent State: We will use chrome.storage.session to save the summary and chat history for a specific PDF. This way, if the user closes the side panel and reopens it on the same document, their conversation is still there.
This roadmap will not only make the extension more powerful and efficient but will also demonstrate advanced concepts in Chrome extension development.
