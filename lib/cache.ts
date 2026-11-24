import 'server-only';

import { createHash } from 'node:crypto';

import { HOSTED } from './hosted';
import { readDataFile, writeDataFile } from './store';

/** A hex key for the given images and text. */
export function sha1(...parts: (Buffer | string)[]): string {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

/**
 * A text model's answer worked out once per key: kept in `memory` while the server runs and,
 * locally, as JSON under data/cache/<dir>/, so a restart doesn't pay for it again. A failed one
 * isn't kept: the next call tries again.
 */
export function cachedJson<T>(memory: Map<string, Promise<T>>, dir: string, key: string, make: () => Promise<T>): Promise<T> {
  let value = memory.get(key);
  if (!value) {
    value = (async () => {
      const file = `cache/${dir}/${key}.json`;
      const saved = HOSTED ? null : await readDataFile(file).catch(() => null);
      if (saved) return JSON.parse(saved.toString()) as T;
      const made = await make();
      if (!HOSTED) void writeDataFile(file, Buffer.from(JSON.stringify(made))).catch(() => {});
      return made;
    })();
    memory.set(key, value);
    value.catch(() => memory.delete(key));
  }
  return value;
}
