'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { cx } from '@/lib/client';
import { useRun, type LoadedRun } from '@/lib/local/hooks';

import lib from '../library/Library.module.css';
import ui from '../ui.module.css';
import styles from './RunView.module.css';

/** A run from this browser's storage: loading, not here (another browser, cleared data), or shown. */
export function LocalRun({ id, back, children }: { id: string; back: string; children: (loaded: LoadedRun) => ReactNode }) {
  const { loaded, error } = useRun(id);
  if (loaded) return children(loaded);
  return (
    <main className={styles.layout}>
      {error ? (
        <p className={cx(ui.notice, ui.noticeError)}>
          <span className={ui.dot} />
          {error}
        </p>
      ) : loaded === null ? (
        <div className={lib.empty}>
          <p className={lib.emptyTitle}>This book is not in this browser</p>
          <p className={ui.muted}>Books are kept in the browser they were made in. Clearing its site data removes them.</p>
          <Link href={back} className={cx(ui.btn, ui.secondary)}>
            Back
          </Link>
        </div>
      ) : (
        <span className={ui.spinner} aria-label="Loading" />
      )}
    </main>
  );
}
