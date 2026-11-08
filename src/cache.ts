export interface CacheStats {
  count: number;
  bytes: number;
}

interface CacheRecord {
  key: string;
  blob: Blob;
  size: number;
  ts: number;
}

const DB_NAME = 'ms-tts-cache';
const STORE_NAME = 'audio';

export class AudioCache {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private maxBytes = 200 * 1024 * 1024;
  private writes = 0;

  setMaxBytes(bytes: number): void {
    this.maxBytes = Math.max(0, bytes);
  }

  private open(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') {
          resolve(null);
          return;
        }
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            store.createIndex('ts', 'ts');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  async get(key: string): Promise<Blob | null> {
    const db = await this.open();
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => {
          const record = request.result as CacheRecord | undefined;
          if (!record?.blob) {
            resolve(null);
            return;
          }
          record.ts = Date.now();
          try {
            const writeTx = db.transaction(STORE_NAME, 'readwrite');
            writeTx.objectStore(STORE_NAME).put(record);
          } catch {
            // 更新 LRU 时间失败不影响命中
          }
          resolve(record.blob);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async put(key: string, blob: Blob): Promise<void> {
    const db = await this.open();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const record: CacheRecord = { key, blob, size: blob.size, ts: Date.now() };
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });

    this.writes++;
    if (this.writes % 10 === 0) void this.evict(this.maxBytes);
  }

  async stats(): Promise<CacheStats> {
    const db = await this.open();
    if (!db) return { count: 0, bytes: 0 };

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).openCursor();
        let count = 0;
        let bytes = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            const record = cursor.value as CacheRecord;
            count++;
            bytes += record.size ?? record.blob?.size ?? 0;
            cursor.continue();
          } else {
            resolve({ count, bytes });
          }
        };
        request.onerror = () => resolve({ count: 0, bytes: 0 });
      } catch {
        resolve({ count: 0, bytes: 0 });
      }
    });
  }

  async evict(maxBytes: number): Promise<void> {
    if (maxBytes <= 0) return;
    const db = await this.open();
    if (!db) return;

    const records = await new Promise<Array<{ key: string; size: number; ts: number }>>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).openCursor();
        const list: Array<{ key: string; size: number; ts: number }> = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            const value = cursor.value as CacheRecord;
            list.push({ key: value.key, size: value.size ?? value.blob?.size ?? 0, ts: value.ts });
            cursor.continue();
          } else {
            resolve(list);
          }
        };
        request.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });

    let total = records.reduce((sum, record) => sum + record.size, 0);
    if (total <= maxBytes) return;

    records.sort((a, b) => a.ts - b.ts);
    const target = Math.max(0, Math.floor(maxBytes * 0.8));

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const record of records) {
          if (total <= target) break;
          store.delete(record.key);
          total -= record.size;
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async clear(): Promise<void> {
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async close(): Promise<void> {
    const db = await this.dbPromise;
    db?.close();
  }
}
