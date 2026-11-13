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

/** Vercel takes at most 4.5 MB per request, and a page call carries several images. */
const UPLOAD_MAX_BYTES = 1_200_000;
const UPLOAD_MAX_SIDE = 2048;

/** The image as it is when small enough to send, else re-saved as a JPEG of at most 2048 px. */
export async function uploadable(blob: Blob): Promise<Blob> {
  if (blob.size <= UPLOAD_MAX_BYTES) return blob;
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? blob), 'image/jpeg', 0.9));
}
