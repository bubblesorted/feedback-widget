/**
 * Local drafts: IndexedDB, one draft per tab key, 24 hours. Expired
 * drafts are removed whenever the store is read. Writes keep their order.
 */

import type { CaptureDraft } from "../contract";

const DB = "feedback-widget-v1";
const STORE = "drafts";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("The local draft store did not open."));
  });
}

export async function readDraft(key: string): Promise<CaptureDraft | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const value = entry.value as CaptureDraft | undefined;
      if (!value?.expiresAt || value.expiresAt < Date.now()) entry.delete();
      entry.continue();
    };
    const request = store.get(key);
    tx.oncomplete = () => {
      db.close();
      const draft = request.result as CaptureDraft | undefined;
      resolve(draft && draft.expiresAt > Date.now() ? draft : undefined);
    };
    tx.onerror = () => {
      db.close();
      reject(new Error("The local draft could not be restored."));
    };
  });
}

async function persist(key: string, draft: CaptureDraft): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(draft, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(new Error("The draft could not be saved in this browser. Keep this page open."));
    };
  });
}

let pending: Promise<void> = Promise.resolve();

/** Saves a draft after every earlier save, so typing, capturing and sealing land in order. */
export function writeDraft(key: string, draft: CaptureDraft): Promise<void> {
  const next = pending.catch(() => {}).then(() => persist(key, draft));
  pending = next;
  return next;
}
