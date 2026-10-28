import Link from 'next/link';

import { cx } from '@/lib/client';
import { bookReady, fileUrl, pageReadiness, type Book } from '@/lib/types';

import { CheckIcon } from '../icons';
import ui from '../ui.module.css';
import styles from './Library.module.css';

/** One book. Make a book: the whole card selects it. Edit books: the whole card opens the editor. */
export function BookCard({ book, selected, onSelect }: { book: Book; selected?: boolean; onSelect?: () => void }) {
  const cover = book.pages.find((p) => p.kind === 'cover') ?? book.pages[0];
  const { ready, total } = pageReadiness(book);
  const story = book.pages.filter((p) => p.kind !== 'skip').length;
  const body = (
    <>
      <span className={styles.cover} style={{ aspectRatio: `${book.pageWidth} / ${book.pageHeight}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fileUrl(`books/${book.id}/${cover.thumb}`)} alt="" />
        {selected && (
          <span className={styles.picked}>
            <CheckIcon />
            Chosen
          </span>
        )}
      </span>
      <span className={styles.cardTitle}>{book.title}</span>
      <span className={styles.cardMeta}>
        {onSelect ? (
          `${story} pages · ${book.characters.map((c) => c.label).join(', ') || 'no characters yet'}`
        ) : (
          <>
            <span className={cx(ui.dot, total && ready === total ? ui.dotOk : ui.dotWarn)} />
            {story} pages · {book.characters.length} {book.characters.length === 1 ? 'character' : 'characters'} · {ready}/{total} ready
          </>
        )}
      </span>
      {!onSelect && <span className={styles.visibility}>{bookReady(book) ? 'Customers see it' : 'Hidden from customers until every page is ready'}</span>}
    </>
  );
  return (
    <li className={cx(styles.card, book.pageWidth > book.pageHeight && styles.cardWide, selected && styles.cardSelected)}>
      {onSelect ? (
        <button type="button" className={styles.cardLink} onClick={onSelect} aria-pressed={!!selected}>
          {body}
        </button>
      ) : (
        <Link href={`/books/${book.id}`} className={styles.cardLink}>
          {body}
        </Link>
      )}
    </li>
  );
}
