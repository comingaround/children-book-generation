import 'server-only';

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { HttpError } from './http-error';
import type { Book, Child, Run, RunSummary } from './types';

/** Everything the CMS keeps lives in data/: books/, children/, runs/. Plain files, no database. */
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

export const getBook = (id: string) => readJson<Book>(dataPath('books', id, 'book.json'));

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

// ---- children ----------------------------------------------------------------

export const getChild = (id: string) => readJson<Child>(dataPath('children', id, 'child.json'));

export async function requireChild(id: string): Promise<Child> {
  const child = await getChild(id);
  if (!child) throw new HttpError(404, 'Child not found');
  return child;
}

export const saveChild = (child: Child) => writeJson(dataPath('children', child.id, 'child.json'), child);

export async function listChildren(): Promise<Child[]> {
  const children = await Promise.all((await listDirs('children')).map(getChild));
  return children.filter((c): c is Child => !!c).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const deleteChild = (id: string) => rm(dataPath('children', id), { recursive: true, force: true });

// ---- runs --------------------------------------------------------------------

export const getRun = (id: string) => readJson<Run>(dataPath('runs', id, 'run.json'));

export async function requireRun(id: string): Promise<Run> {
  const run = await getRun(id);
  if (!run) throw new HttpError(404, 'Run not found');
  return run;
}

export const saveRun = (run: Run) => writeJson(dataPath('runs', run.id, 'run.json'), run);

/** The image a step currently shows: its chosen attempt, else its newest. */
export function chosenFile(step: { attempts: { file: string }[]; selected: number | null }): string | null {
  if (!step.attempts.length) return null;
  return step.attempts[step.selected ?? step.attempts.length - 1]?.file ?? null;
}

export async function listRuns(): Promise<RunSummary[]> {
  const runs = (await Promise.all((await listDirs('runs')).map(getRun))).filter((r): r is Run => !!r);
  const books = new Map((await listBooks()).map((b) => [b.id, b]));
  const children = new Map((await listChildren()).map((c) => [c.id, c]));
  return runs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((run) => {
      const steps = Object.values(run.pages);
      const first = run.pageIndexes.map((i) => run.pages[i]).find((s) => s && chosenFile(s));
      return {
        id: run.id,
        bookId: run.bookId,
        bookTitle: books.get(run.bookId)?.title ?? run.bookId,
        childName: children.get(run.childId)?.name ?? 'Deleted child',
        createdAt: run.createdAt,
        status: run.status,
        done: steps.filter((s) => s.status === 'done').length,
        total: steps.length,
        cover: (first && chosenFile(first)) ?? chosenFile(run.character),
      };
    });
}

export const deleteRun = (id: string) => rm(dataPath('runs', id), { recursive: true, force: true });
