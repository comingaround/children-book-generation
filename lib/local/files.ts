import { del, get, prefixRange, put } from './idb';
import { hasLocalUrl, LOCAL, localKeys, setLocalUrl } from './urls';

/**
 * Images kept in this browser: people's photos and drawings, a run's drawings and pages. Keys
 * read like the paths earlier versions used under data/, prefixed with LOCAL:
 * `idb:children/<person>/photo-….jpg`, `idb:runs/<run>/pages/03-….jpg`.
 */

export const localKey = (path: string) => `${LOCAL}${path}`;

export async function saveFile(key: string, blob: Blob): Promise<string> {
  await put('files', blob, key);
  setLocalUrl(key, URL.createObjectURL(blob));
  return key;
}

export async function readFile(key: string): Promise<Blob> {
  const blob = await get<Blob>('files', key);
  if (!blob) throw new Error('A picture is missing from this browser’s storage');
  return blob;
}

/** A copy under a new key (a saved drawing reused in a run, a run's drawing kept on the person). */
export const copyFile = async (from: string, to: string) => saveFile(to, await readFile(from));

/** Gives every key an object URL, so fileUrl() can show it. Missing files are skipped. */
export async function loadFiles(keys: (string | null | undefined)[]): Promise<void> {
  const wanted = [...new Set(keys)].filter((k): k is string => !!k && k.startsWith(LOCAL) && !hasLocalUrl(k));
  await Promise.all(
    wanted.map(async (key) => {
      const blob = await get<Blob>('files', key);
      if (blob) setLocalUrl(key, URL.createObjectURL(blob));
    })
  );
}

export async function deleteFile(key: string | null | undefined): Promise<void> {
  if (!key?.startsWith(LOCAL)) return;
  await del('files', key);
  setLocalUrl(key, null);
}

/** Deletes every file whose key starts with `prefix` (a run's folder, a person's drawings). */
export async function deleteFiles(prefix: string): Promise<void> {
  const range = prefixRange(prefix);
  await del('files', range);
  for (const key of localKeys()) if (key.startsWith(prefix)) setLocalUrl(key, null);
}
