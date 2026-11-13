'use client';

import Link from 'next/link';
import { useState } from 'react';

import { cx } from '@/lib/client';
import { chosenFile, DISPLAY_ONLY, fileUrl, presentOn, type Book, type BookCharacter, type Example } from '@/lib/types';

import { BookFonts, BookPage } from '../BookPage';
import { BackIcon, BookIcon, RedoIcon } from '../icons';
import { BeforeAfter } from '../run/BeforeAfter';
import { Flipbook } from '../run/Flipbook';
import run$ from '../run/RunView.module.css';
import ui from '../ui.module.css';
import styles from './Preview.module.css';

/** A finished book published with the site: who plays whom, every page before and after, the PDF. */
export function ExampleView({ example, book, pdfUrl }: { example: Example; book: Book; pdfUrl: string }) {
  const [reading, setReading] = useState(false);
  const { run, cast } = example;
  const characterOf = (id: string) => book.characters.find((c) => c.id === id);
  const names: [string, string][] = cast
    .map((p) => [characterOf(p.characterId)?.nameInText.trim() ?? '', p.name] as [string, string])
    .filter(([from, to]) => from && to);
  const who = cast.map((p) => p.name).join(', ').replace(/, ([^,]*)$/, ' & $1');
  const pages = run.pageIndexes.map((i) => book.pages.find((p) => p.index === i)).filter((p) => !!p);
  const castIds = cast.map((p) => p.characterId);

  return (
    <main className={styles.layout}>
      <BookFonts book={book} />

      <header className={styles.head}>
        <Link href="/" className={cx(ui.btn, ui.ghost, ui.small, ui.back)}>
          <BackIcon />
          All books
        </Link>
        <span className={cx(ui.chip, ui.sage)}>Example</span>
        <h1 className={styles.title}>
          {book.title} <span className={run$.with}>with</span> {who}
        </h1>
        <p className={cx(ui.muted, styles.intro)}>
          A whole book made by this engine from {cast.length === 1 ? 'one photo' : `${cast.length} photos`}. Each person is drawn once in the book&apos;s
          style, then every page is redrawn with them: faces, hair and skin change; clothing, poses and the rest of the art stay as the
          illustrator made them. Drag across a page to compare it with the original.
        </p>
        <p className={ui.help}>{DISPLAY_ONLY}</p>
      </header>

      <section className={cx(ui.panel, styles.check)}>
        <h2 className={ui.panelTitle}>From photo to character</h2>
        <p className={ui.help}>{who} are AI-generated sample people, not real children. Their photos were made with AI.</p>
        <ul className={run$.castCards}>
          {cast.map((person) => (
            <li key={person.characterId} className={run$.castCard}>
              <div className={run$.charImages}>
                <figure className={run$.photo}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(person.photo)} alt={`Photo of ${person.name}`} />
                  <figcaption>{person.name}</figcaption>
                </figure>
                <span className={run$.arrow} aria-hidden="true">
                  →
                </span>
                <figure className={run$.drawing}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(person.drawing)} alt={`${person.name} in the book's style`} />
                  <figcaption>as {characterOf(person.characterId)?.label ?? 'a character'}</figcaption>
                </figure>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.pagesSection}>
        <div className={styles.pagesHead}>
          <h2 className={ui.panelTitle}>Every page</h2>
          <span className={ui.muted}>{pages.length} pages · drag across a page to see the original</span>
          <div className={ui.row}>
            <button className={cx(ui.btn, ui.secondary, ui.small)} onClick={() => setReading(true)}>
              <BookIcon />
              Read it
            </button>
            <a href={pdfUrl} className={cx(ui.btn, ui.secondary, ui.small)} download={`${book.title} with ${who}.pdf`}>
              Download PDF
            </a>
          </div>
        </div>
        <ul className={run$.pages}>
          {pages.map((page) => {
            const file = chosenFile(run.pages[page.index]);
            const label = page.kind === 'cover' ? 'Cover' : `Page ${page.index}`;
            return (
              <li key={page.index} className={cx(run$.pageCard, book.pageWidth > book.pageHeight && run$.pageCardWide)}>
                <strong>{label}</strong>
                {file ? (
                  <BeforeAfter
                    label={label}
                    before={<BookPage book={book} page={page} />}
                    after={<BookPage book={book} page={page} art={file} names={names} texts={run.text?.[page.index]} />}
                  />
                ) : (
                  <BookPage book={book} page={page} />
                )}
                <RedoPreview label={label} onPage={presentOn(book, page).filter((c) => castIds.includes(c.id))} />
              </li>
            );
          })}
        </ul>
      </section>

      <section className={styles.order}>
        <div className={styles.orderText}>
          <h2 className={ui.panelTitle}>Now with your own photos</h2>
          <p>Choose a book, add a photo for each character and get a free preview of the cover and a page in a few minutes.</p>
        </div>
        <Link href="/" className={cx(ui.btn, ui.primary)}>
          Make your own
        </Link>
      </section>

      {reading && <Flipbook book={book} run={run} names={names} onClose={() => setReading(false)} />}
    </main>
  );
}

/**
 * The Regenerate controls a page has in your own book, shown switched off: the example is
 * finished, but visitors should see that any page they don't like can be redrawn with a fix.
 */
function RedoPreview({ label, onPage }: { label: string; onPage: BookCharacter[] }) {
  return (
    // A tap focuses it, so the bubble shows on phones too.
    <div className={styles.redoPreview} tabIndex={0} aria-describedby={`redo-${label}`} onClick={(e) => e.currentTarget.focus()}>
      <span id={`redo-${label}`} role="tooltip" className={styles.redoBubble}>
        Disabled for preview book
      </span>
      <fieldset disabled className={styles.redoControls}>
        {onPage.length > 1 && (
          <div className={ui.segmented} role="group" aria-label={`Who the fix for ${label} is for`}>
            <button className={ui.segment} aria-pressed>
              Everyone
            </button>
            {onPage.map((c) => (
              <button key={c.id} className={ui.segment} aria-pressed={false}>
                {c.label}
              </button>
            ))}
          </div>
        )}
        <label className={run$.fix}>
          <span className={ui.srOnly}>Optional correction for {label}</span>
          <input className={cx(ui.input, run$.fixInput)} placeholder="Optional fix, e.g. facing away from us" />
        </label>
        <div className={run$.pageFoot}>
          <button className={cx(ui.btn, ui.secondary, ui.small, run$.redo)}>
            <RedoIcon />
            Regenerate
          </button>
        </div>
      </fieldset>
    </div>
  );
}
