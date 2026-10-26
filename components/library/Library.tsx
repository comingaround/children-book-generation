'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { ago, api, cx } from '@/lib/client';
import { fileUrl, pageReadiness, type Book, type Person, type RunSummary } from '@/lib/types';

import { CheckIcon, PlusIcon } from '../icons';
import { RunStatusChip } from '../RunStatusChip';
import ui from '../ui.module.css';
import styles from './Library.module.css';
import { RunPanel } from './RunPanel';

interface Props {
  books: Book[];
  initialPeople: Person[];
  runs: RunSummary[];
  price: number;
}

export function Library({ books, initialPeople, runs, price }: Props) {
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

function BookCard({ book, selected, onSelect }: { book: Book; selected: boolean; onSelect: () => void }) {
  const cover = book.pages.find((p) => p.kind === 'cover') ?? book.pages[0];
  const { ready, total } = pageReadiness(book);
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
          <span className={cx(ui.dot, total && ready === total ? ui.dotOk : ui.dotWarn)} />
          {story} pages · {book.characters.length} {book.characters.length === 1 ? 'character' : 'characters'} · {ready}/{total} ready
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

