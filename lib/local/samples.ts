import { type Person, type SamplePerson } from '../types';
import { localKey, saveFile } from './files';
import { get, put } from './idb';
import { listPeople, savePerson } from './store';

/**
 * Our own sample people (synthetic photos, the cast of the published examples), put into every
 * visitor's browser once so they can try a book without a photo of their own. Their drawings for
 * the example's book come along, so using them there costs no drawing. Someone who deletes one
 * doesn't get them back: the `meta` flag remembers they were added. The list: samplePeople() in types.ts.
 */
const FLAG = 'samples-added';

const download = async (path: string) => {
  const res = await fetch(`/api/files/${path}`);
  if (!res.ok) throw new Error(`Could not load ${path}`);
  return res.blob();
};

let adding: Promise<void> | null = null;

/** Adds the sample people this browser hasn't had yet. Quietly does nothing if offline. */
export function addSamplePeople(samples: SamplePerson[]): Promise<void> {
  adding ??= (async () => {
    const added = new Set((await get<string[]>('meta', FLAG)) ?? []);
    // Someone of that name already here (the owner's own copy of a sample) counts as added.
    const names = new Set((await listPeople()).map((p) => p.name));
    // Oldest first in the list, so the visitor's own people stay on top.
    const at = Date.parse('2026-01-01T00:00:00Z');
    for (const [i, s] of samples.entries()) {
      if (added.has(s.id) || names.has(s.name)) continue;
      const photo = await saveFile(localKey(`children/${s.id}/photo.jpg`), await download(s.photo));
      const drawings: Record<string, string> = {};
      for (const [key, path] of Object.entries(s.drawings)) {
        drawings[key] = await saveFile(localKey(`children/${s.id}/characters/${key.replace('/', '-')}.jpg`), await download(path));
      }
      const createdAt = new Date(at - i * 1000).toISOString();
      const person: Person = { id: s.id, name: s.name, gender: s.gender, age: s.age, notes: s.notes, photo, createdAt, consentAt: createdAt, drawings };
      await savePerson(person);
      added.add(s.id);
      await put('meta', [...added], FLAG);
    }
  })()
    .catch((err) => console.error('[samples]', err))
    .finally(() => (adding = null));
  return adding;
}
