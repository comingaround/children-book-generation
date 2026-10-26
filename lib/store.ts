import 'server-only';

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { HttpError } from './http-error';
import { migrateBook, migratePerson, migrateRun } from './migrate';
import { chosenFile, type Book, type Person, type Run, type RunSummary } from './types';

/** Everything the CMS keeps lives in data/: books/, children/ (people), runs/. Plain files, no database. */
export const DATA = resolve(process.cwd(), 'data');

/** Resolves a path inside data/, refusing anything that climbs out of it. */
export function dataPath(...parts: string[]): string {
  const full = resolve(DATA, ...parts);
  if (full !== DATA && !full.startsWith(DATA + sep)) throw new HttpError(400, 'Bad path');
  return full;
}

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Write-then-rename, so a reader never sees half a file. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

export async function writeFileIn(relative: string, data: Buffer): Promise<string> {
  const full = dataPath(relative);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  return relative.replaceAll('\\', '/');
}

export const readDataFile = (relative: string) => readFile(dataPath(relative));

async function listDirs(sub: string): Promise<string[]> {
  const dir = dataPath(sub);
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
}

// ---- books -------------------------------------------------------------------

export const getBook = async (id: string) => {
  const book = await readJson<Book>(dataPath('books', id, 'book.json'));
  return book && migrateBook(book);
};

export async function requireBook(id: string): Promise<Book> {
  const book = await getBook(id);
  if (!book) throw new HttpError(404, 'Book not found');
  return book;
}

export const saveBook = (book: Book) => writeJson(dataPath('books', book.id, 'book.json'), book);

export async function listBooks(): Promise<Book[]> {
  const books = await Promise.all((await listDirs('books')).map(getBook));
  return books.filter((b): b is Book => !!b).sort((a, b) => a.title.localeCompare(b.title));
}

export const deleteBook = (id: string) => rm(dataPath('books', id), { recursive: true, force: true });

// ---- people (stored in data/children/, where the first version kept them) ------------------

export const getPerson = async (id: string) => {
  const person = await readJson<Person>(dataPath('children', id, 'child.json'));
  return person && migratePerson(person);
};

export async function requirePerson(id: string): Promise<Person> {
  const person = await getPerson(id);
  if (!person) throw new HttpError(404, 'Person not found');
  return person;
}

export const savePerson = (person: Person) => writeJson(dataPath('children', person.id, 'child.json'), person);

export async function listPeople(): Promise<Person[]> {
  const people = await Promise.all((await listDirs('children')).map(getPerson));
  return people.filter((p): p is Person => !!p).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const deletePerson = (id: string) => rm(dataPath('children', id), { recursive: true, force: true });

// ---- runs --------------------------------------------------------------------

export const getRun = async (id: string) => {
  const run = await readJson<Run>(dataPath('runs', id, 'run.json'));
  return run && migrateRun(run);
};

export async function requireRun(id: string): Promise<Run> {
  const run = await getRun(id);
  if (!run) throw new HttpError(404, 'Run not found');
  return run;
}

export const saveRun = (run: Run) => writeJson(dataPath('runs', run.id, 'run.json'), run);

export async function listRuns(): Promise<RunSummary[]> {
  const runs = (await Promise.all((await listDirs('runs')).map(getRun))).filter((r): r is Run => !!r);
  const books = new Map((await listBooks()).map((b) => [b.id, b]));
  const people = new Map((await listPeople()).map((p) => [p.id, p]));
  return runs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((run) => {
      const steps = Object.values(run.pages);
      const first = run.pageIndexes.map((i) => run.pages[i]).find((s) => s && chosenFile(s));
      return {
        id: run.id,
        bookId: run.bookId,
        bookTitle: books.get(run.bookId)?.title ?? run.bookId,
        people: run.cast.map((c) => people.get(c.personId)?.name ?? 'Deleted person').join(', '),
        createdAt: run.createdAt,
        status: run.status,
        done: steps.filter((s) => s.status === 'done').length,
        total: steps.length,
        cover: (first && chosenFile(first)) ?? (run.cast[0] ? chosenFile(run.cast[0]) : null),
      };
    });
}

export const deleteRun = (id: string) => rm(dataPath('runs', id), { recursive: true, force: true });
