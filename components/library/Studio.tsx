'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { ago, api, cx } from '@/lib/client';
import { fileUrl, type Book, type RunSummary } from '@/lib/types';

import { PlusIcon } from '../icons';
import { RunStatusChip } from '../RunStatusChip';
import ui from '../ui.module.css';
import { BookCard } from './BookCard';
import styles from './Library.module.css';

/** Edit books: the owner's side. Import a PDF and prepare its characters, boxes and style. */
export function Studio({ books, runs }: { books: Book[]; runs: RunSummary[] }) {
  const router = useRouter();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function importPdf(file: File) {
    setImporting(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('pdf', file);
      const { id } = await api<{ id: string }>('/api/books', { method: 'POST', body: form });
      router.push(`/books/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setImporting(false);
    }
  }

  return (
    <main className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.head}>
          <div>
            <h1 className={styles.title}>Edit books</h1>
            <p className={ui.muted}>
              For the shop owner: import a book once and prepare who is where. Customers see a book under Make a book once every page is ready.
            </p>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            className={ui.srOnly}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importPdf(file);
            }}
          />
          <button className={cx(ui.btn, ui.secondary)} onClick={() => fileInput.current?.click()} disabled={importing}>
            {importing ? <span className={ui.spinner} /> : <PlusIcon />}
            {importing ? 'Importing…' : 'Import PDF'}
          </button>
        </div>

        {error && (
          <p className={cx(ui.notice, ui.noticeError)}>
            <span className={ui.dot} />
            {error}
          </p>
        )}

        {books.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No books yet</p>
            <p className={ui.muted}>Import a picture-book PDF to start, or run <code>npm run import:samples</code>.</p>
          </div>
        ) : (
          <ul className={styles.grid}>
            {books.map((book) => (
              <BookCard key={book.id} book={book} />
            ))}
          </ul>
        )}

        <section className={styles.runs}>
          <h2 className={ui.panelTitle}>Runs</h2>
          {runs.length === 0 ? (
            <p className={ui.muted}>Nothing generated yet. Customers start runs under Make a book; here you get the tools for each one: versions, fixes and costs.</p>
          ) : (
            <ul className={styles.runList}>
              {runs.slice(0, 20).map((run) => (
                <li key={run.id}>
                  <Link href={`/runs/${run.id}`} className={styles.runRow}>
                    <span className={styles.runThumb}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {run.cover && <img src={fileUrl(run.cover)} alt="" />}
                    </span>
                    <span className={styles.runText}>
                      <strong>{run.bookTitle}</strong>
                      <span className={ui.muted} suppressHydrationWarning>
                        {run.people} · {run.ordered ? 'ordered' : run.preview ? 'preview' : 'test run'} · {ago(run.createdAt)}
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
    </main>
  );
}
