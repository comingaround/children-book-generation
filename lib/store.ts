import 'server-only';

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { HttpError } from './http-error';
import { migrateBook, migratePerson, migrateRun } from './migrate';
import type { Book, Example, Person, Run } from './types';

/** Books live in data/books/ (plain files, no database); data/children/ and data/runs/ only hold older saves. */
export const DATA = resolve(process.cwd(), 'data');

/** Resolves a path inside data/, refusing anything that climbs out of it. */
export function dataPath(...parts: string[]): string {
  const full = resolve(DATA, ...parts);
  if (full !== DATA && !full.startsWith(DATA + sep)) throw new HttpError(400, 'Bad path');
  return full;
}

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

// ---- examples (finished runs published with the site) ---------------------------------------

export const getExample = (id: string) => readJson<Example>(dataPath('examples', id, 'example.json'));

export async function listExamples(): Promise<Example[]> {
  const examples = await Promise.all((await listDirs('examples')).map(getExample));
  return examples.filter((e): e is Example => !!e).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export const saveExample = (example: Example) => writeJson(dataPath('examples', example.id, 'example.json'), example);

export async function writeDataFile(relative: string, data: Buffer): Promise<void> {
  const full = dataPath(relative);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
}

// ---- people and runs on disk ---------------------------------------------------------------
// People and runs now live in the browser (lib/local/). These read what earlier versions saved
// in data/children/ and data/runs/, once, for the browser to copy in (app/api/legacy).

export async function listPeople(): Promise<Person[]> {
  const people = await Promise.all((await listDirs('children')).map((id) => readJson<Person>(dataPath('children', id, 'child.json'))));
  return people.filter((p): p is Person => !!p).map(migratePerson);
}

export async function listRuns(): Promise<Run[]> {
  const runs = await Promise.all((await listDirs('runs')).map((id) => readJson<Run>(dataPath('runs', id, 'run.json'))));
  return runs.filter((r): r is Run => !!r).map(migrateRun);
}
