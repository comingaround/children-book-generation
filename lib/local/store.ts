import { api } from '../client';
import { migratePerson, migrateRun } from '../migrate';
import { bookFile, chosenFile, type Book, type Person, type Run, type RunSummary } from '../types';
import { deleteFile, deleteFiles, localKey, readFile } from './files';
import { del, get, getAll, put, request, tx } from './idb';

/**
 * People, runs and imported books, kept in this browser. Every change is announced (here and in other tabs of
 * the same site) so open pages update without polling; `kick` asks the tab drawing a run to
 * look at it again (runner.ts).
 */

export type Change = { kind: 'run'; id: string } | { kind: 'people' } | { kind: 'books' } | { kind: 'kick'; id: string };

const events = typeof window === 'undefined' ? null : new EventTarget();
let channel: BroadcastChannel | null = null;

function channelOf(): BroadcastChannel | null {
  if (!channel && events && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('baby-book-preview');
    channel.onmessage = (e: MessageEvent<Change>) => events.dispatchEvent(new CustomEvent('change', { detail: e.data }));
  }
  return channel;
}

export function emit(change: Change): void {
  events?.dispatchEvent(new CustomEvent('change', { detail: change }));
  channelOf()?.postMessage(change);
}

export function onChange(listener: (change: Change) => void): () => void {
  channelOf();
  const handler = (e: Event) => listener((e as CustomEvent<Change>).detail);
  events?.addEventListener('change', handler);
  return () => events?.removeEventListener('change', handler);
}

export function newId(prefix: string): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${Date.now().toString(36)}${random}`;
}

// ---- books ------------------------------------------------------------------------------
// Books imported in this browser are kept here (local: true); published ones are on the server.

export const getLocalBook = async (id: string) => (await get<Book>('books', id)) ?? null;

export const listLocalBooks = async () => (await getAll<Book>('books')).sort((a, b) => a.title.localeCompare(b.title));

/** A book by id: this browser's own first, else the server's. */
export const loadBook = async (id: string) => (await getLocalBook(id)) ?? api<Book>(`/api/books/${id}`);

/** Saves a book where it lives: this browser, or (the owner, locally) data/books/ on the server. */
export async function saveBook(book: Book): Promise<void> {
  if (book.local) {
    await put('books', book);
    emit({ kind: 'books' });
    return;
  }
  await api(`/api/books/${book.id}`, { method: 'PUT', json: { title: book.title, characters: book.characters, settings: book.settings, pages: book.pages } });
}

export async function deleteBook(book: Book): Promise<void> {
  if (!book.local) {
    await api(`/api/books/${book.id}`, { method: 'DELETE' });
    return;
  }
  await del('books', book.id);
  await deleteFiles(localKey(`books/${book.id}/`));
  emit({ kind: 'books' });
}

/**
 * Names the book in an AI call's spec: a published one by id, a browser one whole, with the art
 * the call reads (`images`, paths from book.json) attached as files (see lib/book-input.ts).
 */
export async function bookSpec(book: Book, form?: FormData, images: string[] = []): Promise<{ bookId: string } | { book: Book }> {
  if (!book.local) return { bookId: book.id };
  for (const image of new Set(images)) form?.set(`book:${image}`, await readFile(bookFile(book, image)));
  return { book };
}

// ---- runs ------------------------------------------------------------------------------

export const getRun = async (id: string) => {
  const run = await get<Run>('runs', id);
  return run ? migrateRun(run) : null;
};

export async function requireRun(id: string): Promise<Run> {
  const run = await getRun(id);
  if (!run) throw new Error('This run is not in this browser');
  return run;
}

export const listRuns = async () => (await getAll<Run>('runs')).map(migrateRun).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export async function addRun(run: Run): Promise<void> {
  await put('runs', run);
  emit({ kind: 'run', id: run.id });
}

/**
 * Load, change and save a run in one transaction, so no other change (another worker, another
 * tab) lands in between. `change` must be synchronous; throwing in it leaves the run as it was.
 */
export async function mutate(runId: string, change: (run: Run) => void): Promise<Run> {
  const run = await tx('runs', 'readwrite', async (t) => {
    const runs = t.objectStore('runs');
    const raw = await request(runs.get(runId) as IDBRequest<Run | undefined>);
    if (!raw) throw new Error('This run is no longer in this browser');
    const run = migrateRun(raw);
    change(run);
    await request(runs.put(run));
    return run;
  });
  emit({ kind: 'run', id: runId });
  return run;
}

export async function deleteRun(id: string): Promise<void> {
  await del('runs', id);
  await deleteFiles(localKey(`runs/${id}/`));
  emit({ kind: 'run', id });
}

/** One row per run for the lists, newest first. */
export function summarize(runs: Run[], books: Book[], people: Person[]): RunSummary[] {
  return runs.map((run) => {
    const steps = Object.values(run.pages);
    const first = run.pageIndexes.map((i) => run.pages[i]).find((s) => s && chosenFile(s));
    return {
      id: run.id,
      bookId: run.bookId,
      bookTitle: books.find((b) => b.id === run.bookId)?.title ?? 'A removed book',
      people: run.cast.map((c) => people.find((p) => p.id === c.personId)?.name ?? 'Deleted person').join(', '),
      createdAt: run.createdAt,
      status: run.status,
      preview: !!run.preview,
      ordered: !!run.ordered,
      done: steps.filter((s) => s.status === 'done').length,
      total: steps.length,
      images: run.images,
      cover: (first && chosenFile(first)) ?? (run.cast[0] ? chosenFile(run.cast[0]) : null),
    };
  });
}

// ---- people ----------------------------------------------------------------------------

export const getPerson = async (id: string) => {
  const person = await get<Person>('people', id);
  return person ? migratePerson(person) : null;
};

export async function requirePerson(id: string): Promise<Person> {
  const person = await getPerson(id);
  if (!person) throw new Error('That person was removed');
  return person;
}

export const listPeople = async () => (await getAll<Person>('people')).map(migratePerson).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export async function savePerson(person: Person): Promise<Person> {
  await put('people', person);
  emit({ kind: 'people' });
  return person;
}

/** The whole profile and its files. Runs keep their own copies of the drawings. */
export async function deletePerson(id: string): Promise<void> {
  await del('people', id);
  await deleteFiles(localKey(`children/${id}/`));
  emit({ kind: 'people' });
}

/** Only the photo and the drawings made from it. */
export async function deletePhoto(id: string): Promise<Person> {
  const person = await requirePerson(id);
  await deleteFile(person.photo);
  for (const file of Object.values(person.drawings)) await deleteFile(file);
  return savePerson({ ...person, photo: null, drawings: {} });
}
