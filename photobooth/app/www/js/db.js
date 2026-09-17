// IndexedDB storage for things that must survive an app restart:
// the device id, the cached frame list, and the upload queue (with blobs).

const DB_NAME = "photobooth";
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // A blocked or stuck open must not leave the booth on a blank screen.
    const timer = setTimeout(() => {
      dbPromise = null;
      reject(new Error("IndexedDB open timed out"));
    }, 4000);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => console.warn("IndexedDB open blocked by another connection");
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" });
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kv = {
  get: (key) => run("kv", "readonly", (s) => s.get(key)),
  set: (key, value) => run("kv", "readwrite", (s) => void s.put(value, key)),
};

export const queueStore = {
  put: (item) => run("queue", "readwrite", (s) => void s.put(item)),
  delete: (id) => run("queue", "readwrite", (s) => void s.delete(id)),
  async all() {
    const items = await run("queue", "readonly", (s) => s.getAll());
    return (items ?? []).sort((a, b) => a.createdAt - b.createdAt);
  },
};

export async function deviceId() {
  let id = await kv.get("deviceId");
  if (!id) {
    id = `tablet-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await kv.set("deviceId", id);
  }
  return id;
}
