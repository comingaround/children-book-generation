import { ApiError, api, apiBlob } from '../client';
import { textChanges, type TextCast } from '../text';
import {
  canDrawTogether,
  characterArt,
  chosenFile,
  drawingKey,
  FIX_MAX,
  personFacts,
  testPages,
  type Book,
  type CastStep,
  type Page,
  type Person,
  type Run,
  type RunStep,
  type StepStatus,
} from '../types';
import { copyFile, localKey, readFile, saveFile } from './files';
import { addRun, bookSpec, emit, getRun, loadBook, mutate, newId, onChange, requirePerson, requireRun, savePerson } from './store';

/**
 * Runs are drawn by the page, not the server: this loop sends one image call at a time to the
 * AI endpoints (app/api/ai/*) and keeps every answer in this browser. Step 1 draws every
 * assigned person in the book's style and stops for approval; step 2 makes the pages, two at a
 * time (Google's image capacity is the bottleneck), each assigned character replaced in turn.
 *
 * One tab draws a run (it holds a Web Lock on it while open); other tabs show it and `kick` the
 * drawing tab after a change. A run left mid-way carries on when its page is opened again: in
 * a tab that just took the lock, nothing is in flight, so anything still marked working is redone.
 */

const PAGE_CONCURRENCY = 2;
/** When Google is still busy after the server's own retries, a page gets one more go this much later. */
const BUSY_RETRY_MS = 30_000;

/** Runs this tab draws, with the steps it has in flight ('text', 'cast:<id>', 'page:<index>'). */
const owned = new Map<string, Set<string>>();
const busyRetried = new Set<string>();

if (typeof window !== 'undefined') onChange((c) => c.kind === 'kick' && owned.has(c.id) && void work(c.id));

const emptyStep = (status: RunStep['status']): RunStep => ({ status, attempts: [], selected: null, message: null });

const errorMessage = (err: unknown) => (err instanceof Error && err.message ? err.message : 'Something went wrong — try again');

function castStep(run: Run, characterId: string): CastStep {
  const step = run.cast.find((c) => c.characterId === characterId);
  if (!step) throw new Error('That character is not in this run');
  return step;
}

/** Busy, waiting for review, or ready for pages, from the state of every cast drawing. */
function castStatus(run: Run): Run['status'] {
  if (run.cast.every((c) => c.approved)) return run.status === 'done' ? 'done' : 'pages';
  return run.cast.every((c) => c.approved || c.status === 'done' || c.status === 'error') ? 'review' : 'character';
}

// ---- who draws a run ------------------------------------------------------------------

/** Takes the run's lock if no other tab holds it; kept until this tab closes. */
function claim(runId: string): Promise<boolean> {
  if (owned.has(runId)) return Promise.resolve(true);
  if (!navigator.locks) {
    owned.set(runId, new Set());
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    void navigator.locks.request(`bbp-run-${runId}`, { ifAvailable: true }, (lock) => {
      if (!lock) return resolve(false);
      owned.set(runId, new Set());
      resolve(true);
      return new Promise<void>(() => undefined);
    });
  });
}

/** Makes sure someone draws the run's queued steps: this tab if it can, else the tab that does. */
export async function kick(runId: string): Promise<void> {
  if (await claim(runId)) void work(runId);
  else emit({ kind: 'kick', id: runId });
}

/** Starts whatever the run needs and nobody here is doing yet. */
async function work(runId: string): Promise<void> {
  const inFlight = owned.get(runId);
  const run = inFlight && (await getRun(runId));
  if (!inFlight || !run) return;
  const todo = (key: string, status: StepStatus | undefined) => !inFlight.has(key) && (status === 'queued' || status === 'working');
  const start = (key: string, job: () => Promise<void>) => {
    inFlight.add(key);
    void job()
      .catch((err) => console.error(`[run] ${key}`, err))
      .finally(() => {
        inFlight.delete(key);
        void work(runId);
      });
  };

  if (run.textStatus === 'working' && !inFlight.has('text')) start('text', () => rewriteText(runId));
  for (const c of run.cast) if (!c.approved && todo(`cast:${c.characterId}`, c.status)) start(`cast:${c.characterId}`, () => drawCharacter(runId, c.characterId));
  if (run.status !== 'pages') return;

  let pages = [...inFlight].filter((k) => k.startsWith('page:')).length;
  for (const index of run.pageIndexes) {
    if (pages >= PAGE_CONCURRENCY) break;
    if (!todo(`page:${index}`, run.pages[index]?.status)) continue;
    pages++;
    start(`page:${index}`, () => drawPage(runId, index));
  }
  const finished = (r: Run) => Object.values(r.pages).every((s) => s.status === 'done' || s.status === 'error');
  if (pages === 0 && finished(run)) {
    await mutate(runId, (r) => {
      if (r.status === 'pages' && finished(r)) r.status = 'done';
    });
  }
}

// ---- create ----------------------------------------------------------------------

export interface Assignment {
  characterId: string;
  personId: string;
}

const textCast = (run: Run, people: Person[]): TextCast[] =>
  run.cast.flatMap((c) => {
    const person = people.find((p) => p.id === c.personId);
    return person ? [{ characterId: c.characterId, name: person.name, gender: person.gender }] : [];
  });

/**
 * `together`: every character on a page in one image call instead of one call each.
 * `preview`: a customer's free preview, protected from saving until they order the full book.
 */
export async function createRun(book: Book, assignments: Assignment[], pageIndexes: number[], reuseDrawings: boolean, together = false, preview = false): Promise<Run> {
  if (!assignments.length) throw new Error('Choose a person for at least one character');
  if (!pageIndexes.length) throw new Error('None of these characters are on any page yet');
  const people = await Promise.all(assignments.map((a) => requirePerson(a.personId)));
  for (const [i, person] of people.entries()) {
    if (!book.characters.some((c) => c.id === assignments[i].characterId)) throw new Error('That character is no longer in the book');
    if (!person.photo) throw new Error(`${person.name} has no photo`);
  }

  const run: Run = {
    id: newId('run'),
    bookId: book.id,
    createdAt: new Date().toISOString(),
    status: 'character',
    pageIndexes,
    together,
    preview,
    cast: [],
    pages: Object.fromEntries(pageIndexes.map((i) => [String(i), emptyStep('waiting')])),
    images: 0,
  };
  for (const [i, a] of assignments.entries()) {
    const saved = reuseDrawings ? people[i].drawings[drawingKey(book.id, a.characterId)] : undefined;
    const file = saved && (await copyFile(saved, localKey(`runs/${run.id}/cast-${a.characterId}-saved.jpg`)).catch(() => null));
    if (file) {
      run.cast.push({ ...a, status: 'done', attempts: [{ file, at: run.createdAt, ms: 0 }], selected: 0, message: null, approved: true, reused: true });
    } else {
      run.cast.push({ ...a, ...emptyStep('queued'), approved: false, reused: false });
    }
  }
  run.status = castStatus(run);
  if (run.status === 'pages') for (const step of Object.values(run.pages)) step.status = 'queued';
  if (textChanges(book, textCast(run, people)).changes.length) run.textStatus = 'working';
  await addRun(run);
  await kick(run.id);
  return run;
}

// ---- he/she in the text ------------------------------------------------------------------

/**
 * When someone plays a character of the other gender (a girl as Ross), the cheap text model
 * rewrites the book's text once for the run (app/api/ai/text). Pages show the names swapped
 * only until it's done, or if it fails.
 */
async function rewriteText(runId: string): Promise<void> {
  try {
    const run = await requireRun(runId);
    const people = await Promise.all(run.cast.map((c) => requirePerson(c.personId).catch(() => null)));
    const book = await loadBook(run.bookId);
    const { text } = await api<{ text: Record<string, string[]> }>('/api/ai/text', {
      method: 'POST',
      json: { ...(await bookSpec(book)), cast: textCast(run, people.filter((p): p is Person => !!p)) },
    });
    await mutate(runId, (r) => {
      r.text = text;
      r.textStatus = 'done';
    });
  } catch (err) {
    console.error('[run] text', errorMessage(err));
    await mutate(runId, (r) => void (r.textStatus = 'error'));
  }
}

/** The owner's "Try the text again" after the rewrite failed. */
export async function retryText(runId: string): Promise<Run> {
  const run = await mutate(runId, (r) => void (r.textStatus = 'working'));
  await kick(runId);
  return run;
}

// ---- step 1: the people, drawn in the book's style ---------------------------------------

async function drawCharacter(runId: string, characterId: string): Promise<void> {
  const started = Date.now();
  try {
    const run = await mutate(runId, (r) => {
      const step = castStep(r, characterId);
      step.status = 'working';
      step.message = null;
      r.status = castStatus(r);
    });
    const person = await requirePerson(castStep(run, characterId).personId);
    if (!person.photo) throw new Error(`${person.name} has no photo`);
    const book = await loadBook(run.bookId);
    const { style, sample } = characterArt(book, characterId);
    const form = new FormData();
    const spec = await bookSpec(book, form, [style.image, ...(sample ? [sample.image] : [])]);
    form.set('spec', JSON.stringify({ ...spec, characterId, person: personFacts(person) }));
    form.set('photo', await readFile(person.photo));
    const file = await saveFile(localKey(`runs/${runId}/cast-${characterId}-${Date.now().toString(36)}.jpg`), await apiBlob('/api/ai/character', { method: 'POST', body: form }));

    await mutate(runId, (r) => {
      const step = castStep(r, characterId);
      r.images++;
      r.drawings = (r.drawings ?? 0) + 1;
      step.status = 'done';
      step.message = null;
      step.attempts.push({ file, at: new Date().toISOString(), ms: Date.now() - started });
      step.selected = step.attempts.length - 1;
      r.status = castStatus(r);
    });
  } catch (err) {
    console.error('[run] character', errorMessage(err));
    await mutate(runId, (r) => {
      const step = castStep(r, characterId);
      step.status = 'error';
      step.message = errorMessage(err);
      r.status = castStatus(r);
    });
  }
}

export async function regenerateCharacter(runId: string, characterId: string): Promise<Run> {
  const run = await mutate(runId, (r) => {
    const step = castStep(r, characterId);
    if (step.status === 'working' || step.status === 'queued') throw new Error('Already being drawn');
    if (step.approved) throw new Error('Already approved');
    step.status = 'queued';
    step.message = null;
    r.status = castStatus(r);
  });
  await kick(runId);
  return run;
}

export function selectCharacter(runId: string, characterId: string, attempt: number): Promise<Run> {
  return mutate(runId, (r) => {
    const step = castStep(r, characterId);
    if (step.approved) throw new Error('Already approved');
    if (!step.attempts[attempt]) throw new Error('No such attempt');
    step.selected = attempt;
  });
}

/** Saves every drawing on its person for reuse with this book, then starts the pages. */
export async function approveCast(runId: string): Promise<Run> {
  const run = await mutate(runId, (r) => {
    for (const step of r.cast) {
      if (step.status === 'working' || step.status === 'queued') throw new Error('Wait until every drawing is finished');
      if (!chosenFile(step)) throw new Error('One of the drawings failed — draw it again first');
    }
    for (const step of r.cast) step.approved = true;
    r.status = 'pages';
    for (const step of Object.values(r.pages)) if (step.status === 'waiting') step.status = 'queued';
  });
  for (const step of run.cast) {
    if (step.reused) continue;
    const person = await requirePerson(step.personId).catch(() => null);
    if (!person) continue;
    const key = drawingKey(run.bookId, step.characterId);
    person.drawings[key] = await copyFile(chosenFile(step)!, localKey(`children/${person.id}/characters/${run.bookId}-${step.characterId}.jpg`));
    await savePerson(person);
  }
  await kick(runId);
  return run;
}

// ---- step 2: the pages ------------------------------------------------------------------

/** One character on a page, ready to send. */
interface Member {
  characterId: string;
  label: string;
  person: Person;
  drawing: string;
}

/** One image call on a page: `group` replaced on `art` (null = the book's own art). */
async function drawOnPage(book: Book, page: Page, art: Blob | null, group: Member[], fix: string | null, fixFor: string | null): Promise<Blob> {
  const form = new FormData();
  const spec = await bookSpec(book, form, art ? [] : [page.image]);
  form.set('spec', JSON.stringify({ ...spec, index: page.index, members: group.map((m) => ({ characterId: m.characterId, person: personFacts(m.person) })), fix, fixFor }));
  for (const [n, m] of group.entries()) {
    form.set(`photo-${n}`, await readFile(m.person.photo!));
    form.set(`drawing-${n}`, await readFile(m.drawing));
  }
  if (art) form.set('art', art);
  return apiBlob('/api/ai/page', { method: 'POST', body: form });
}

/**
 * One version of a page. One by one (default): each assigned character replaced in turn on the
 * same image. All at once (run.together, when canDrawTogether): one image call for all of them.
 */
async function drawPage(runId: string, index: number): Promise<void> {
  const started = Date.now();
  const say = (message: string) => mutate(runId, (r) => void (r.pages[index].message = message));
  try {
    const run = await mutate(runId, (r) => {
      r.pages[index].status = 'working';
      r.pages[index].message = null;
    });
    const book = await loadBook(run.bookId);
    const page = book.pages.find((p) => p.index === index);
    if (!page) throw new Error(`Page ${index} is no longer in the book`);
    const { fix = null, fixFor = null } = run.pages[index];
    const members: Member[] = [];
    for (const step of run.cast) {
      const character = book.characters.find((b) => b.id === step.characterId);
      if (!character || !page.cast[step.characterId]?.present) continue;
      const person = await requirePerson(step.personId);
      if (!person.photo) throw new Error(`${person.name} has no photo`);
      members.push({ characterId: character.id, label: character.label, person, drawing: chosenFile(step)! });
    }
    if (!members.length) throw new Error('No one to draw on this page');
    const together = !!run.together && canDrawTogether(book, page, members.map((m) => m.characterId));

    let art: Blob | null = null;
    for (const group of together ? [members] : members.map((m) => [m])) {
      const label = together ? '' : members.length > 1 ? `${group[0].label}: ` : '';
      await say(together ? 'Drawing everyone at once…' : `${label}drawing…`);
      art = await drawOnPage(book, page, art, group, fix, fixFor);
      await mutate(runId, (r) => void r.images++);
    }

    const file = await saveFile(localKey(`runs/${runId}/pages/${String(index).padStart(2, '0')}-${Date.now().toString(36)}.jpg`), art!);
    await mutate(runId, (r) => {
      const step = r.pages[index];
      step.attempts.push({
        file,
        at: new Date().toISOString(),
        ms: Date.now() - started,
        ...(together ? { together: true } : {}),
        ...(fix ? { fix, ...(fixFor ? { fixFor } : {}) } : {}),
      });
      step.selected = step.attempts.length - 1;
      step.status = 'done';
      step.message = null;
      step.fix = null;
      step.fixFor = null;
    });
    busyRetried.delete(`${runId}:${index}`);
  } catch (err) {
    console.error(`[run] page ${index}`, errorMessage(err));
    const key = `${runId}:${index}`;
    if (err instanceof ApiError && err.status === 503 && !busyRetried.has(key)) {
      busyRetried.add(key);
      await say('Google is busy — trying again in 30 s');
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      return drawPage(runId, index);
    }
    busyRetried.delete(key);
    await mutate(runId, (r) => {
      r.pages[index].status = 'error';
      r.pages[index].message = errorMessage(err);
    });
  }
}

/**
 * `fix` is an optional short correction for this one attempt, e.g. "facing away from us, like
 * the original"; `fixFor` limits it to one character (default: everyone on the page).
 */
export async function regeneratePage(runId: string, index: number, fix?: string, fixFor?: string | null): Promise<Run> {
  const run = await mutate(runId, (r) => {
    const step = r.pages[index];
    if (!step) throw new Error('That page is not in this run');
    if (!r.cast.every((c) => c.approved)) throw new Error('Approve the drawings first');
    if (step.status === 'working' || step.status === 'queued') throw new Error('That page is already being made');
    if (fixFor && !r.cast.some((c) => c.characterId === fixFor)) throw new Error('That character is not in this run');
    step.status = 'queued';
    step.message = null;
    step.fix = fix?.trim().slice(0, FIX_MAX) || null;
    step.fixFor = step.fix ? fixFor || null : null;
    r.status = 'pages';
  });
  await kick(runId);
  return run;
}

/** The customer orders the full book: every other page with their characters joins the run. */
export async function orderFullBook(runId: string): Promise<Run> {
  const book = await loadBook((await requireRun(runId)).bookId);
  const run = await mutate(runId, (r) => {
    if (r.ordered) throw new Error('Already ordered');
    const all = testPages(book, 'all', r.cast.map((c) => c.characterId));
    const approved = r.cast.every((c) => c.approved);
    for (const i of all) if (!r.pages[i]) r.pages[i] = emptyStep(approved ? 'queued' : 'waiting');
    r.pageIndexes = all.filter((i) => r.pages[i]);
    r.ordered = true;
    if (approved) r.status = 'pages';
  });
  await kick(runId);
  return run;
}

export const setTogether = (runId: string, together: boolean) => mutate(runId, (r) => void (r.together = together));

export function selectPageAttempt(runId: string, index: number, attempt: number): Promise<Run> {
  return mutate(runId, (r) => {
    const step = r.pages[index];
    if (!step?.attempts[attempt]) throw new Error('No such attempt');
    step.selected = attempt;
  });
}
