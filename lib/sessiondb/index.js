const DB_NAME = 'pdfAMA';
const DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';
const VECTORS_STORE = 'pdfVectors';

let db;

async function initDB() {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.createObjectStore(SESSIONS_STORE, { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains(VECTORS_STORE)) {
        const vectorStore = db.createObjectStore(VECTORS_STORE, { autoIncrement: true });
        vectorStore.createIndex('pdfUrl', 'pdfUrl', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => {
      console.error('Database error:', event.target.errorCode);
      reject(event.target.errorCode);
    };
  });
}

async function getSession(url) {
  const db = await initDB();
  const transaction = db.transaction([SESSIONS_STORE], 'readonly');
  const store = transaction.objectStore(SESSIONS_STORE);
  return new Promise((resolve, reject) => {
    const request = store.get(url);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

async function saveSession(session) {
  const db = await initDB();
  const transaction = db.transaction([SESSIONS_STORE], 'readwrite');
  const store = transaction.objectStore(SESSIONS_STORE);
  return new Promise((resolve, reject) => {
    const request = store.put(session);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

export { initDB, getSession, saveSession, VECTORS_STORE };
