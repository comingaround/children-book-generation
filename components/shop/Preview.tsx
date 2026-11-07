'use client';

import Link from 'next/link';
import { useState } from 'react';

import { cx, money } from '@/lib/client';
import { downloadPdf } from '@/lib/local/pdf';
import { approveCast, orderFullBook, regenerateCharacter, regeneratePage, setTogether } from '@/lib/local/runner';
import { deletePhoto } from '@/lib/local/store';
import { canDrawTogether, chosenFile, fileUrl, pageImageCount, testPages, type Book, type CastStep, type Person, type Run, type RunStep } from '@/lib/types';

import { BookFonts, BookPage } from '../BookPage';
import { BackIcon, BookIcon, CheckIcon, RedoIcon } from '../icons';
import { BeforeAfter } from '../run/BeforeAfter';
import { Flipbook } from '../run/Flipbook';
import { LocalRun } from '../run/LocalRun';
import { TogetherSwitch } from '../TogetherSwitch';
import run$ from '../run/RunView.module.css';
import ui from '../ui.module.css';
import styles from './Preview.module.css';

const busyStep = (s: RunStep) => s.status === 'queued' || s.status === 'working';

/**
 * The customer's side of a run: check the drawings, see the preview pages (protected from saving), order
 * the full book. The owner's tools for the same run (versions, fixes, costs) are on /runs/<id>.
 */
/** `pdf`: whether the PDF can be made here (not on the hosted demo, which has no Python). */
export function Preview({ id, price, pdf }: { id: string; price: number; pdf: boolean }) {
  return (
    <LocalRun id={id} back="/">
      {(loaded) => <PreviewBody {...loaded} price={price} pdf={pdf} />}
    </LocalRun>
  );
}

function PreviewBody({ run, book, people, price, pdf }: { run: Run; book: Book; people: Person[]; price: number; pdf: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [saving, setSaving] = useState(false);

  /** A change to the run; the page updates from storage once it is saved. */
  async function act(change: () => Promise<unknown>) {
    setError(null);
    try {
      await change();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const personOf = (step: CastStep) => people.find((p) => p.id === step.personId) ?? null;
  const characterOf = (id: string) => book.characters.find((c) => c.id === id);
  const castIds = run.cast.map((c) => c.characterId);
  const approved = run.cast.every((c) => c.approved);
  const drawing = run.cast.some((c) => !c.approved && busyStep(c));
  const canApprove = !approved && !drawing && run.cast.every((c) => chosenFile(c));
  const pages = run.pageIndexes.map((i) => book.pages.find((p) => p.index === i)).filter((p) => !!p);
  const done = pages.filter((p) => run.pages[p.index]?.status === 'done').length;
  const who = run.cast.map((c) => personOf(c)?.name ?? 'someone').join(' & ');
  const names: [string, string][] = run.cast
    .map((c) => [characterOf(c.characterId)?.nameInText.trim() ?? '', personOf(c)?.name ?? ''] as [string, string])
    .filter(([from, to]) => from && to);

  // What ordering adds: every other page with these characters, drawn as the switch says.
  const rest = testPages(book, 'all', castIds).filter((i) => !run.pages[i]);
  const restImages = pageImageCount(book, rest, castIds, !!run.together);
  const shared = rest.some((i) => canDrawTogether(book, book.pages.find((p) => p.index === i)!, castIds));

  async function order() {
    const note = `Demo, no payment. This draws the other ${rest.length} pages: about ${restImages} images, ${money(restImages * price)} of AI.`;
    if (!window.confirm(note)) return;
    await act(() => orderFullBook(run.id));
  }

  async function deletePhotos() {
    if (!window.confirm(`Delete the photos of ${who} and the drawings made from them? This book stays.`)) return;
    await act(async () => {
      await Promise.all(run.cast.map((c) => deletePhoto(c.personId).catch(() => null)));
      setDeleted(true);
    });
  }

  async function savePdf() {
    setSaving(true);
    await act(() => downloadPdf(book, run, names, false));
    setSaving(false);
  }

  return (
    <main className={cx(styles.layout, ui.protect)} onContextMenu={(e) => e.preventDefault()}>
      <BookFonts book={book} />

      <header className={styles.head}>
        <Link href="/" className={cx(ui.btn, ui.ghost, ui.small, ui.back)}>
          <BackIcon />
          All books
        </Link>
        <h1 className={styles.title}>
          {book.title} <span className={run$.with}>with</span> {who}
        </h1>
        <p className={ui.muted}>{run.ordered ? 'Your full book' : 'Your free preview'}</p>
      </header>

      {error && (
        <p className={cx(ui.notice, ui.noticeError)}>
          <span className={ui.dot} />
          {error}
        </p>
      )}

      {!approved && (
        <section className={cx(ui.panel, styles.check)}>
          <div className={styles.checkHead}>
            <h2 className={ui.panelTitle}>{drawing ? `Drawing ${who} in the book's style…` : `Does this look like ${who}?`}</h2>
            <p className={ui.muted}>
              {drawing
                ? 'This takes about a minute. Every page is then drawn from this picture, so it matters most.'
                : 'Every page is drawn from this picture. If it does not look right, try again — it is free.'}
            </p>
          </div>
          <ul className={run$.castCards}>
            {run.cast.map((step) => {
              const person = personOf(step);
              const file = chosenFile(step);
              return (
                <li key={step.characterId} className={run$.castCard}>
                  <div className={run$.charImages}>
                    <figure className={run$.photo}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {person?.photo ? <img src={fileUrl(person.photo)} alt={`Photo of ${person.name}`} /> : <span className={ui.muted}>No photo</span>}
                      <figcaption>{person?.name ?? 'Deleted person'}</figcaption>
                    </figure>
                    <span className={run$.arrow} aria-hidden="true">
                      →
                    </span>
                    <figure className={run$.drawing}>
                      {file && step.status !== 'working' ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={fileUrl(file)} alt={`${person?.name ?? 'Person'} in the book's style`} />
                      ) : (
                        <span className={run$.placeholder}>{step.status === 'error' ? 'Could not draw' : <span className={ui.spinner} />}</span>
                      )}
                      <figcaption>as {characterOf(step.characterId)?.label ?? 'a character'}</figcaption>
                    </figure>
                  </div>
                  {step.status === 'error' && step.message && (
                    <p className={cx(ui.notice, ui.noticeError)}>
                      <span className={ui.dot} />
                      {step.message}
                    </p>
                  )}
                  {(file || step.status === 'error') && (
                    <button
                      className={cx(ui.btn, ui.secondary, ui.small)}
                      onClick={() => act(() => regenerateCharacter(run.id, step.characterId))}
                      disabled={busyStep(step)}
                    >
                      <RedoIcon />
                      Try again
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div>
            <button className={cx(ui.btn, ui.primary)} onClick={() => act(() => approveCast(run.id))} disabled={!canApprove}>
              <CheckIcon />
              Yes, make my preview
            </button>
          </div>
        </section>
      )}

      <section className={styles.pagesSection}>
        <div className={styles.pagesHead}>
          <h2 className={ui.panelTitle}>{run.ordered ? 'Your book' : 'Preview'}</h2>
          <span className={ui.muted}>{approved ? `${done} of ${pages.length} pages ready · drag across a page to see the original` : 'Starts once you say yes above'}</span>
          <button className={cx(ui.btn, ui.secondary, ui.small)} onClick={() => setReading(true)} disabled={done === 0}>
            <BookIcon />
            Read it
          </button>
        </div>
        <ul className={run$.pages}>
          {pages.map((page) => {
            const step = run.pages[page.index];
            const file = chosenFile(step);
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
                  <div className={run$.pending}>
                    <BookPage book={book} page={page} />
                    <span className={run$.pendingVeil}>
                      {step.status === 'working' && <span className={ui.spinner} />}
                      {step.status === 'waiting' && 'Waits for your yes above'}
                      {step.status === 'queued' && 'Next in line'}
                      {step.status === 'working' && 'Drawing…'}
                      {step.status === 'error' && 'Could not draw this page'}
                    </span>
                  </div>
                )}
                {step.status === 'error' && (
                  <button
                    className={cx(ui.btn, ui.secondary, ui.small)}
                    onClick={() => act(() => regeneratePage(run.id, page.index))}
                  >
                    <RedoIcon />
                    Try again
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {run.ordered && done === pages.length && (
        <section className={cx(ui.panel, styles.order)}>
          <div className={styles.orderText}>
            <h2 className={ui.panelTitle}>Your book is ready</h2>
            <p>{pdf ? `Every page is done. Download it as a PDF, made from the original book with ${who} in it.` : 'Every page is done. Read it above; in this demo the PDF is made only on the local version.'}</p>
          </div>
          {pdf && (
            <button className={cx(ui.btn, ui.primary)} onClick={savePdf} disabled={saving}>
              {saving && <span className={ui.spinner} />}
              Download PDF
            </button>
          )}
        </section>
      )}

      {!run.ordered && rest.length > 0 && (
        <section className={cx(ui.panel, styles.order)}>
          <div className={styles.orderText}>
            <h2 className={ui.panelTitle}>Like it? Order the whole book</h2>
            {/* On a pastel wash, text stays ink (style guide §1.5). */}
            <p>
              All {rest.length + pages.length} pages with {who} as a PDF to keep. You see every page before it is printed.
            </p>
            {shared && (
              <div className={ui.field}>
                <span className={ui.label}>Pages with more than one of them</span>
                <TogetherSwitch className={styles.mode} together={!!run.together} onChange={(together) => act(() => setTogether(run.id, together))} />
              </div>
            )}
          </div>
          <button className={cx(ui.btn, ui.primary)} onClick={order} disabled={!approved}>
            Order the full book
          </button>
        </section>
      )}

      <p className={cx(ui.help, styles.privacy)}>
        Photos are used only to make this book.{' '}
        {deleted ? (
          'Your photos are deleted.'
        ) : (
          <button className={styles.link} onClick={deletePhotos}>
            Delete my photos
          </button>
        )}
      </p>

      {reading && <Flipbook book={book} run={run} names={names} onClose={() => setReading(false)} />}
    </main>
  );
}
