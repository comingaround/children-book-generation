import Link from 'next/link';

import styles from './TopBar.module.css';

export function TopBar() {
  return (
    <header className={styles.bar}>
      <Link href="/" className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        Baby Book <em>Preview</em>
      </Link>
      <span className={styles.tag}>Internal · local only</span>
    </header>
  );
}
