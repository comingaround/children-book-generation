'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cx } from '@/lib/client';

import styles from './TopBar.module.css';

/** Two separate sides: customers make books, the owner edits them. */
const tabs = [
  { href: '/', label: 'Make a book', who: 'customer' },
  { href: '/studio', label: 'Edit books', who: 'owner' },
];

export function TopBar() {
  const path = usePathname();
  const owner = ['/studio', '/books', '/runs'].some((p) => path.startsWith(p));
  return (
    <header className={styles.bar}>
      <Link href="/" className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        <span className={styles.brandText}>
          Baby Book <em>Preview</em>
        </span>
      </Link>
      <nav className={styles.tabs}>
        {tabs.map((t) => {
          const on = (t.who === 'owner') === owner;
          return (
            <Link key={t.href} href={t.href} className={cx(styles.tab, on && styles.tabOn)} aria-current={on ? 'page' : undefined}>
              {t.label}
              <span className={styles.who}>{t.who}</span>
            </Link>
          );
        })}
      </nav>
      <span className={styles.tag}>Internal · local only</span>
    </header>
  );
}
