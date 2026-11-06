/**
 * Files kept in this browser (IndexedDB, see lib/local/files.ts) have keys starting with LOCAL.
 * lib/local/files.ts registers an object URL for each one it loads, so fileUrl() can stay
 * synchronous. Imported by lib/types.ts, so no browser APIs here: on the server the map is empty.
 */
export const LOCAL = 'idb:';

const urls = new Map<string, string>();

/** A transparent pixel, for a file that isn't loaded (yet). */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export const localUrl = (key: string) => urls.get(key) ?? BLANK;

export const hasLocalUrl = (key: string) => urls.has(key);

export function setLocalUrl(key: string, url: string | null): void {
  const old = urls.get(key);
  if (old) URL.revokeObjectURL(old);
  if (url) urls.set(key, url);
  else urls.delete(key);
}

export const localKeys = () => [...urls.keys()];
