'use client';

import { useEffect, useRef, useState } from 'react';

import type { Book, Person, Run, RunSummary } from '../types';
import { loadFiles } from './files';
import { whenReady } from './legacy';
import { kick } from './runner';
import { getRun, listPeople, listRuns, loadBook, onChange, summarize, type Change } from './store';

/**
 * Loads something from this browser's storage, again after each change it cares about, with
 * every file it shows loaded first. `undefined` while loading.
 */
function useLocal<T>(load: () => Promise<T>, relevant: (change: Change) => boolean, key: string): { value: T | undefined; error: string | null } {
  const [state, setState] = useState<{ key: string; value: T | undefined; error: string | null }>({ key, value: undefined, error: null });

  useEffect(() => {
    let alive = true;
    let pending = false;
    let again = false;
    // One load at a time; changes that arrive meanwhile cause one more load after it.
    const refresh = async () => {
      if (pending) return void (again = true);
      pending = true;
      try {
        await whenReady();
        const value = await load();
        if (alive) setState({ key, value, error: null });
      } catch (err) {
        if (alive) setState({ key, value: undefined, error: (err as Error).message });
      }
      pending = false;
      if (again && alive) {
        again = false;
        void refresh();
      }
    };
    void refresh();
    const stop = onChange((c) => relevant(c) && void refresh());
    return () => {
      alive = false;
      stop();
    };
    // `load` and `relevant` are rebuilt every render; `key` says when they mean something new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state.key === key ? state : { value: undefined, error: null };
}

const runFiles = (run: Run) => [...run.cast, ...Object.values(run.pages)].flatMap((s) => s.attempts.map((a) => a.file));

const photos = (people: Person[]) => people.map((p) => p.photo);

/** Everyone saved in this browser. */
export function usePeople(): Person[] | undefined {
  return useLocal(
    async () => {
      const people = await listPeople();
      await loadFiles(photos(people));
      return people;
    },
    (c) => c.kind === 'people',
    'people'
  ).value;
}

/** The run list, newest first, with titles from `books` (the server's). */
export function useRunSummaries(books: Book[]): RunSummary[] | undefined {
  return useLocal(
    async () => {
      const [runs, people] = await Promise.all([listRuns(), listPeople()]);
      const rows = summarize(runs, books, people);
      await loadFiles(rows.map((r) => r.cover));
      return rows;
    },
    (c) => c.kind === 'people' || c.kind === 'run',
    `runs:${books.map((b) => b.id).join()}`
  ).value;
}

export interface LoadedRun {
  run: Run;
  book: Book;
  people: Person[];
}

/**
 * One run with its book and people; `null` if this browser doesn't have it. Opening it also
 * makes sure it is being drawn (a run left mid-way carries on, see runner.ts).
 */
export function useRun(id: string): { loaded: LoadedRun | null | undefined; error: string | null } {
  // The book is fetched once per page; only the run and its people change while it is open.
  const book = useRef<Book | null>(null);
  const { value, error } = useLocal(
    async () => {
      const run = await getRun(id);
      if (!run) return null;
      if (book.current?.id !== run.bookId) book.current = await loadBook(run.bookId);
      const people = (await listPeople()).filter((p) => run.cast.some((c) => c.personId === p.id));
      await loadFiles([...runFiles(run), ...photos(people)]);
      return { run, book: book.current, people };
    },
    (c) => (c.kind === 'run' && c.id === id) || c.kind === 'people',
    `run:${id}`
  );

  useEffect(() => {
    void whenReady().then(() => kick(id));
  }, [id]);

  return { loaded: value, error };
}
