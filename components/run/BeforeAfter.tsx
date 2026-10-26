'use client';

import { useState, type ReactNode } from 'react';

import styles from './BeforeAfter.module.css';

/** Two layers of the same size; drag (or arrow-key) the divider to compare them. */
export function BeforeAfter({ before, after, label }: { before: ReactNode; after: ReactNode; label: string }) {
  const [split, setSplit] = useState(50);
  return (
    <div className={styles.frame}>
      <div className={styles.layer}>{before}</div>
      <div className={styles.layer} style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
        {after}
      </div>
      <div className={styles.divider} style={{ left: `${split}%` }} aria-hidden="true">
        <span className={styles.handle}>‹ ›</span>
      </div>
      <span className={`${styles.tag} ${styles.left}`}>Original</span>
      <span className={`${styles.tag} ${styles.right}`}>Generated</span>
      <input
        type="range"
        min={0}
        max={100}
        step={0.5}
        value={split}
        onChange={(e) => setSplit(Number(e.target.value))}
        className={styles.range}
        aria-label={`Compare original and generated: ${label}`}
      />
    </div>
  );
}
