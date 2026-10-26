'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { ago, api, cx } from '@/lib/client';
import { fileUrl, pageState, type Book, type Child, type RunSummary } from '@/lib/types';

import { CheckIcon, PlusIcon } from '../icons';
import ui from '../ui.module.css';
import { ChildPanel } from './ChildPanel';
import styles from './Library.module.css';

interface Props {
  books: Book[];
  initialChildren: Child[];
  runs: RunSummary[];
  price: number;
}

export function Library({ books, initialChildren, runs, price }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(books[0]?.id ?? null);
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
            <h1 className={styles.title}>Library</h1>
            <p className={ui.muted}>
              {books.length} {books.length === 1 ? 'book' : 'books'} · open a book to prepare it, select one to generate
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
              <BookCard key={book.id} book={book} selected={selected === book.id} onSelect={() => setSelected(book.id)} />
            ))}
          </ul>
        )}

        <section className={styles.runs}>
          <h2 className={ui.panelTitle}>Recent runs</h2>
          {runs.length === 0 ? (
            <p className={ui.muted}>Nothing generated yet. Choose a book and a child on the right.</p>
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
                        {run.childName} · {ago(run.createdAt)}
                      </span>
                    </span>
                    <RunChip run={run} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className={styles.side}>
        <ChildPanel book={books.find((b) => b.id === selected) ?? null} initialChildren={initialChildren} price={price} />
      </aside>
    </main>
  );
}

function BookCard({ book, selected, onSelect }: { book: Book; selected: boolean; onSelect: () => void }) {
  const cover = book.pages.find((p) => p.kind === 'cover') ?? book.pages[0];
  const heroPages = book.pages.filter((p) => ['ready', 'needsBox'].includes(pageState(p)));
  const ready = heroPages.filter((p) => pageState(p) === 'ready').length;
  const story = book.pages.filter((p) => p.kind !== 'skip').length;
  return (
    <li className={cx(styles.card, book.pageWidth > book.pageHeight && styles.cardWide, selected && styles.cardSelected)}>
      <Link href={`/books/${book.id}`} className={styles.cardLink}>
        <span className={styles.cover} style={{ aspectRatio: `${book.pageWidth} / ${book.pageHeight}` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fileUrl(`books/${book.id}/${cover.thumb}`)} alt="" />
        </span>
        <span className={styles.cardTitle}>{book.title}</span>
        <span className={styles.cardMeta}>
          <span className={cx(ui.dot, ready === heroPages.length ? ui.dotOk : ui.dotWarn)} />
          {story} pages · {ready}/{heroPages.length} main-character pages ready
        </span>
      </Link>
      <button
        className={cx(styles.pick, selected && styles.pickOn)}
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`Generate ${book.title}`}
      >
        {selected ? <CheckIcon /> : null}
        {selected ? 'Selected' : 'Select'}
      </button>
    </li>
  );
}

function RunChip({ run }: { run: RunSummary }) {
  if (run.status === 'done') return <span className={cx(ui.chip, ui.sage)}>Done · {run.done}/{run.total}</span>;
  if (run.status === 'review') return <span className={cx(ui.chip, ui.butter)}>Check character</span>;
  return <span className={cx(ui.chip, ui.sky)}>{run.status === 'character' ? 'Drawing character' : `Pages ${run.done}/${run.total}`}</span>;
}
