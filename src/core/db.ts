import type {
  AnnotationRecord,
  BatchRecord,
  ComparisonRecord,
  FitJobRecord,
  ImageRecord,
  ResultRecord,
  SettingsRecord,
} from '../core/types';

/**
 * IndexedDB 封装。
 * 大体积系数按 tile 分块存 Blob/ArrayBuffer,键:`${prefix}:t${tileIndex}`。
 * 关闭页面后 job.doneTiles 与 chunks 都已落盘,重开可断点续拟合。
 */

const DB_NAME = 'rti-studio';
const DB_VERSION = 1;

const STORES = [
  'kv',
  'batches',
  'images',
  'jobs',
  'results',
  'chunks',
  'annotations',
  'comparisons',
] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, name === 'kv' ? undefined : { keyPath: 'id' });
          if (name === 'images') store.createIndex('batchId', 'batchId');
          if (name === 'jobs') store.createIndex('batchId', 'batchId');
          if (name === 'results') store.createIndex('batchId', 'batchId');
          if (name === 'annotations') store.createIndex('targetId', 'targetId');
          if (name === 'chunks') store.createIndex('prefix', 'prefix');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function put<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value as any));
}
export async function get<T>(store: StoreName, id: string): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
}
export async function del(store: StoreName, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id));
}
export async function getAll<T>(store: StoreName): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}
export async function getAllByIndex<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const req = t.objectStore(store).index(index).getAll(value);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** 清空某 store(谨慎) */
export async function clearStore(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

// ---------- kv ----------
export async function kvGet<T>(key: string): Promise<T | undefined> {
  return tx('kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put({ id: key, value });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---------- chunks(系数/法线分块) ----------
export interface ChunkRecord {
  id: string;
  prefix: string;
  tile: number;
  buffer: ArrayBuffer;
  kind: 'coeff-u8' | 'normal-u8' | 'misc';
}

export async function putChunk(chunk: ChunkRecord): Promise<void> {
  await put<ChunkRecord>('chunks', chunk);
}
export async function getChunk(id: string): Promise<ChunkRecord | undefined> {
  return get<ChunkRecord>('chunks', id);
}
export async function deleteChunksByPrefix(prefix: string): Promise<void> {
  const chunks = await getAllByIndex<ChunkRecord>('chunks', 'prefix', prefix);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('chunks', 'readwrite');
    const s = t.objectStore('chunks');
    for (const c of chunks) s.delete(c.id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---------- 语义化快捷方式 ----------
export const dbApi = {
  batches: {
    list: () => getAll<BatchRecord>('batches'),
    get: (id: string) => get<BatchRecord>('batches', id),
    put: (b: BatchRecord) => put('batches', b),
    del: (id: string) => del('batches', id),
  },
  images: {
    listByBatch: (batchId: string) => getAllByIndex<ImageRecord>('images', 'batchId', batchId),
    get: (id: string) => get<ImageRecord>('images', id),
    put: (i: ImageRecord) => put('images', i),
    del: (id: string) => del('images', id),
  },
  jobs: {
    list: () => getAll<FitJobRecord>('jobs'),
    listByBatch: (batchId: string) => getAllByIndex<FitJobRecord>('jobs', 'batchId', batchId),
    get: (id: string) => get<FitJobRecord>('jobs', id),
    put: (j: FitJobRecord) => put('jobs', j),
    del: (id: string) => del('jobs', id),
  },
  results: {
    list: () => getAll<ResultRecord>('results'),
    listByBatch: (batchId: string) => getAllByIndex<ResultRecord>('results', 'batchId', batchId),
    get: (id: string) => get<ResultRecord>('results', id),
    put: (r: ResultRecord) => put('results', r),
    del: (id: string) => del('results', id),
  },
  annotations: {
    listByTarget: (targetId: string) =>
      getAllByIndex<AnnotationRecord>('annotations', 'targetId', targetId),
    put: (a: AnnotationRecord) => put('annotations', a),
    del: (id: string) => del('annotations', id),
  },
  comparisons: {
    list: () => getAll<ComparisonRecord>('comparisons'),
    get: (id: string) => get<ComparisonRecord>('comparisons', id),
    put: (c: ComparisonRecord) => put('comparisons', c),
    del: (id: string) => del('comparisons', id),
  },
  settings: {
    async get(): Promise<SettingsRecord> {
      const s = await kvGet<SettingsRecord>('settings');
      return (
        s ?? {
          author: '研究员',
          unit: 'mm',
          gpuPreference: 'high-performance',
          tileSize: 256,
          theme: 'dark',
        }
      );
    },
    set: (s: SettingsRecord) => kvSet('settings', s),
  },
};

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
