import type { AudioFrameHeader } from "@realtime-translate/contracts";

const DATABASE_NAME = "realtime-translate-audio";
const STORE_NAME = "chunks";
const DATABASE_VERSION = 1;

export interface StoredChunk {
  sessionId: string;
  seq: number;
  header: AudioFrameHeader;
  audio: Blob;
  createdAt: string;
}

export class ChunkStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async put(chunk: StoredChunk): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(chunk);
    await transactionDone(transaction);
  }

  async list(sessionId: string): Promise<StoredChunk[]> {
    const db = await this.open();
    const transaction = db.transaction(STORE_NAME, "readonly");
    const index = transaction.objectStore(STORE_NAME).index("by-session");
    const result = await requestResult(index.getAll(IDBKeyRange.only(sessionId)));
    await transactionDone(transaction);
    return (result as StoredChunk[]).sort((left, right) => left.seq - right.seq);
  }

  async delete(sessionId: string, seq: number): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete([sessionId, seq]);
    await transactionDone(transaction);
  }

  async deleteThrough(sessionId: string, seq: number): Promise<void> {
    const chunks = await this.list(sessionId);
    const removable = chunks.filter((chunk) => chunk.seq <= seq);
    if (removable.length === 0) return;
    const db = await this.open();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const chunk of removable) store.delete([sessionId, chunk.seq]);
    await transactionDone(transaction);
  }

  async count(sessionId: string): Promise<number> {
    const db = await this.open();
    const transaction = db.transaction(STORE_NAME, "readonly");
    const count = await requestResult(transaction.objectStore(STORE_NAME).index("by-session").count(IDBKeyRange.only(sessionId)));
    await transactionDone(transaction);
    return count;
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore(STORE_NAME, { keyPath: ["sessionId", "seq"] });
        store.createIndex("by-session", "sessionId", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDBを開けませんでした"));
      request.onblocked = () => reject(new Error("IndexedDBの更新がブロックされました"));
    });
    return this.databasePromise;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB operation failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}
