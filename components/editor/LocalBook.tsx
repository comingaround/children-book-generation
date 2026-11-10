'use client';

import Link from 'next/link';

import { cx } from '@/lib/client';
import { useLocalBook } from '@/lib/local/hooks';

import lib from '../library/Library.module.css';
import run from '../run/RunView.module.css';
import ui from '../ui.module.css';
import { BookEditor } from './BookEditor';

/** The editor for a book imported in this browser: loading, not here, or the editor. */
export function LocalBook({ id }: { id: string }) {
  const { book, error } = useLocalBook(id);
  if (book) return <BookEditor initial={book} />;
  return (
    <main className={run.layout}>
      {error ? (
        <p className={cx(ui.notice, ui.noticeError)}>
          <span className={ui.dot} />
          {error}
        </p>
      ) : book === null ? (
        <div className={lib.empty}>
          <p className={lib.emptyTitle}>This book is not in this browser</p>
          <p className={ui.muted}>Books are kept in the browser they were imported in. Clearing its site data removes them.</p>
          <Link href="/studio" className={cx(ui.btn, ui.secondary)}>
            Back
          </Link>
        </div>
      ) : (
        <span className={ui.spinner} aria-label="Loading" />
      )}
    </main>
  );
}
