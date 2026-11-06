import { api } from '../client';
import type { Person, Run, RunStep } from '../types';
import { localKey, saveFile } from './files';
import { get, put } from './idb';
import { emit } from './store';

/**
 * Before runs moved into the browser, the dev server saved people and runs in data/. The first
 * time this browser opens the app, it copies them in once (app/api/legacy), files included,
 * under the same paths with the LOCAL prefix. Online there is nothing to copy.
 */

const FLAG = 'legacyImported';

let ready: Promise<void> | null = null;

/** Resolves once older saves are in this browser; every page waits for it before reading. */
export function whenReady(): Promise<void> {
  ready ??= importOnce().catch((err) => {
    console.error('[legacy]', err);
    ready = null;
  });
  return ready;
}

async function copy(path: string | null): Promise<string | null> {
  if (!path) return null;
  const key = localKey(path);
  if (await get('files', key)) return key;
  const res = await fetch(`/api/files/${path}`);
  if (res.ok) await saveFile(key, await res.blob());
  return key;
}

/** Nothing copied in may start drawing (and spending) on its own. */
function stopped(step: RunStep): void {
  if (step.status !== 'queued' && step.status !== 'working') return;
  step.status = 'error';
  step.message = 'Stopped when the run moved to this browser — try again';
}

async function importOnce(): Promise<void> {
  if (await get('meta', FLAG)) return;
  const { people, runs } = await api<{ people: Person[]; runs: Run[] }>('/api/legacy');

  for (const person of people) {
    if (await get('people', person.id)) continue;
    const drawings: Record<string, string> = {};
    for (const [key, file] of Object.entries(person.drawings)) drawings[key] = (await copy(file))!;
    await put('people', { ...person, photo: await copy(person.photo), drawings });
  }

  for (const run of runs) {
    if (await get('runs', run.id)) continue;
    for (const step of [...run.cast, ...Object.values(run.pages)]) {
      for (const attempt of step.attempts) attempt.file = (await copy(attempt.file))!;
      stopped(step);
    }
    if (run.textStatus === 'working') run.textStatus = 'error';
    await put('runs', run);
  }

  await put('meta', new Date().toISOString(), FLAG);
  if (people.length || runs.length) emit({ kind: 'people' });
}
