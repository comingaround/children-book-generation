/**
 * A thin promise wrapper over this browser's IndexedDB. Stores: `people` and `runs` (JSON, by
 * id), `files` (Blobs, by key, see files.ts) and `meta` (small flags).
 */

const NAME = 'baby-book-preview';
const VERSION = 1;

export type StoreName = 'people' | 'runs' | 'files' | 'meta';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('people', { keyPath: 'id' });
      db.createObjectStore('runs', { keyPath: 'id' });
      db.createObjectStore('files');
      db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(new Error('This browser blocks local storage, so books cannot be saved here (a private window?)'));
    };
  });
  return opening;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * Runs `body` in one transaction and resolves with its result once the transaction commits.
 * IndexedDB queues transactions on the same store, across tabs too, so a read-change-write in
 * one transaction can't interleave with another (see store.ts mutate). Throwing aborts it.
 */
export async function tx<T>(names: StoreName | StoreName[], mode: IDBTransactionMode, body: (t: IDBTransaction) => Promise<T>): Promise<T> {
  const t = (await open()).transaction(names, mode);
  const finished = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error ?? new Error('Saving in this browser failed'));
    t.onerror = () => reject(t.error ?? new Error('Saving in this browser failed'));
  });
  let result: T;
  try {
    result = await body(t);
  } catch (err) {
    try {
      t.abort();
    } catch {
      // Already finished or aborted.
    }
    void finished.catch(() => undefined);
    throw err;
  }
  await finished;
  return result;
}

export const get = <T>(name: StoreName, key: IDBValidKey) => tx(name, 'readonly', (t) => done(t.objectStore(name).get(key) as IDBRequest<T | undefined>));

export const getAll = <T>(name: StoreName, range?: IDBKeyRange) => tx(name, 'readonly', (t) => done(t.objectStore(name).getAll(range) as IDBRequest<T[]>));

export const put = (name: StoreName, value: unknown, key?: IDBValidKey) => tx(name, 'readwrite', (t) => done(t.objectStore(name).put(value, key))).then(() => undefined);

export const del = (name: StoreName, key: IDBValidKey | IDBKeyRange) => tx(name, 'readwrite', (t) => done(t.objectStore(name).delete(key)));

/** Every key that starts with `prefix`. */
export const prefixRange = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`);

export { done as request };
