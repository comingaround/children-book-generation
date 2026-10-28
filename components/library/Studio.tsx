'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { api, cx } from '@/lib/client';
import type { Book } from '@/lib/types';

import { PlusIcon } from '../icons';
import ui from '../ui.module.css';
import { BookCard } from './BookCard';
import styles from './Library.module.css';

/** Edit books: the owner's side. Import a PDF and prepare its characters, boxes and style. */
export function Studio({ books }: { books: Book[] }) {
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
              For the shop owner: import a book once and prepare who is where. Customers only see the finished books under Make a book.
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
      </div>
    </main>
  );
}
