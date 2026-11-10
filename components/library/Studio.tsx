'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { ago, cx, money } from '@/lib/client';
import { useLocalBooks, useRunSummaries } from '@/lib/local/hooks';
import { importPdf as importInBrowser } from '@/lib/local/import';
import { fileUrl, type Book, type RunSummary } from '@/lib/types';

import { PlusIcon } from '../icons';
import { RunStatusChip } from '../RunStatusChip';
import ui from '../ui.module.css';
import { BookCard } from './BookCard';
import styles from './Library.module.css';

/**
 * Edit books: import a PDF and prepare its characters, boxes and style. `books` are the published
 * ones (data/books/, editable on the local version only); imported books stay in this browser.
 */
export function Studio({ books: published, price }: { books: Book[]; price: number }) {
  const router = useRouter();
  const local = useLocalBooks();
  const books = [...published, ...(local ?? [])];
  const runs = useRunSummaries(books) ?? [];
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Imports into this browser (pdf.js); `npm run import:samples` or scripts/import_pdf.py publish one. */
  async function importPdf(file: File) {
    setImporting('Reading the PDF…');
    setError(null);
    try {
      const book = await importInBrowser(file, setImporting);
      router.push(`/books/${book.id}`);
    } catch (err) {
      setError((err as Error).message);
      setImporting(null);
    }
  }

  return (
    <main className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.head}>
          <div>
            <h1 className={styles.title}>Edit books</h1>
            <p className={ui.muted}>
              Import a picture-book PDF and prepare who is where. Books you import stay in this browser and show under Make a book once every page is ready.
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
          <button className={cx(ui.btn, ui.secondary)} onClick={() => fileInput.current?.click()} disabled={!!importing}>
            {importing ? <span className={ui.spinner} /> : <PlusIcon />}
            {importing ?? 'Import PDF'}
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
            <p className={ui.muted}>Import a picture-book PDF to start.</p>
          </div>
        ) : (
          <ul className={styles.grid}>
            {books.map((book) => (
              <BookCard key={book.id} book={book} />
            ))}
          </ul>
        )}

        <section className={styles.runs}>
          <div className={styles.runsHead}>
            <h2 className={ui.panelTitle}>Runs</h2>
            <span className={ui.muted}>{monthCost(runs, price)}</span>
          </div>
          {runs.length === 0 ? (
            <p className={ui.muted}>Nothing generated in this browser yet. Customers start runs under Make a book; here you get the tools for each one: versions, fixes and costs.</p>
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
                    <span className={styles.cost}>{money(run.images * price)}</span>
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

/** "This month: 42 images · $5.63", from the runs started this calendar month. */
function monthCost(runs: RunSummary[], price: number): string {
  const month = new Date().toISOString().slice(0, 7);
  const images = runs.filter((r) => r.createdAt.startsWith(month)).reduce((n, r) => n + r.images, 0);
  return `This month: ${images} ${images === 1 ? 'image' : 'images'} · ${money(images * price)}`;
}
