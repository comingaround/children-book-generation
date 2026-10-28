'use client';

import Link from 'next/link';
import { useState } from 'react';

import { ago } from '@/lib/client';
import { fileUrl, type Book, type Person, type RunSummary } from '@/lib/types';

import { RunStatusChip } from '../RunStatusChip';
import ui from '../ui.module.css';
import { BookCard } from './BookCard';
import styles from './Library.module.css';
import { RunPanel } from './RunPanel';

interface Props {
  books: Book[];
  initialPeople: Person[];
  runs: RunSummary[];
  price: number;
}

/** Make a book: what a customer sees. Choose a book, add the people, generate. */
export function Library({ books, initialPeople, runs, price }: Props) {
  const [selected, setSelected] = useState<string | null>(books[0]?.id ?? null);

  return (
    <main className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.head}>
          <div>
            <h1 className={styles.title}>Make a book</h1>
            <p className={ui.muted}>Choose a book, add your people on the right, and they become its characters.</p>
          </div>
        </div>

        {books.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No books yet</p>
            <p className={ui.muted}>
              Books are added and prepared under <Link href="/studio">Edit books</Link>.
            </p>
          </div>
        ) : (
          <ul className={styles.grid}>
            {books.map((book) => (
              <BookCard key={book.id} book={book} selected={selected === book.id} onSelect={() => setSelected(book.id)} />
            ))}
          </ul>
        )}

        <section className={styles.runs}>
          <h2 className={ui.panelTitle}>Your books</h2>
          {runs.length === 0 ? (
            <p className={ui.muted}>Nothing generated yet. Choose a book and who plays whom on the right.</p>
          ) : (
            <ul className={styles.runList}>
              {runs.slice(0, 12).map((run) => (
                <li key={run.id}>
                  <Link href={`/runs/${run.id}`} className={styles.runRow}>
                    <span className={styles.runThumb}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {run.cover && <img src={fileUrl(run.cover)} alt="" />}
                    </span>
                    <span className={styles.runText}>
                      <strong>{run.bookTitle}</strong>
                      <span className={ui.muted} suppressHydrationWarning>
                        {run.people} · {ago(run.createdAt)}
                      </span>
                    </span>
                    <RunStatusChip status={run.status} done={run.done} total={run.total} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className={styles.side}>
        <RunPanel books={books} selected={selected} onSelect={setSelected} initialPeople={initialPeople} price={price} />
      </aside>
    </main>
  );
}
