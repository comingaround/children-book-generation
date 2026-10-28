'use client';

import { useEffect, useState } from 'react';

import { cx } from '@/lib/client';
import { chosenFile, type Book, type Run } from '@/lib/types';

import { BookPage } from '../BookPage';
import { BackIcon, NextIcon } from '../icons';
import ui from '../ui.module.css';
import styles from './Flipbook.module.css';

/** The finished pages one at a time, as a reader would see them. Arrow keys turn, Esc closes. */
export function Flipbook({ book, run, names, onClose }: { book: Book; run: Run; names: [string, string][]; onClose: () => void }) {
  const pages = run.pageIndexes
    .map((i) => {
      const step = run.pages[i];
      const file = step && chosenFile(step);
      const page = book.pages.find((p) => p.index === i);
      return page && file ? { page, file } : null;
    })
    .filter((p) => !!p);
  const [at, setAt] = useState(0);
  const go = (delta: number) => setAt((n) => Math.min(Math.max(n + delta, 0), pages.length - 1));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setAt((n) => Math.min(n + 1, pages.length - 1));
      if (e.key === 'ArrowLeft') setAt((n) => Math.max(n - 1, 0));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pages.length]);

  const current = pages[at];
  if (!current) return null;
  const wide = book.pageWidth > book.pageHeight;

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-label={`${book.title} — book view`} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={styles.bar}>
          <span className={styles.name}>{book.title}</span>
          <span className={ui.muted}>
            {at + 1} / {pages.length}
          </span>
          <button className={cx(ui.btn, ui.ghost, ui.small)} onClick={onClose}>
            Close
          </button>
        </div>
        <div className={styles.stage}>
          <button className={cx(ui.iconBtn, styles.turn)} onClick={() => go(-1)} disabled={at === 0} aria-label="Previous page">
            <BackIcon />
          </button>
          <BookPage key={current.page.index} book={book} page={current.page} art={current.file} names={names} texts={run.text?.[current.page.index]} className={cx(styles.page, wide ? styles.wide : styles.tall)} />
          <button className={cx(ui.iconBtn, styles.turn)} onClick={() => go(1)} disabled={at === pages.length - 1} aria-label="Next page">
            <NextIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
