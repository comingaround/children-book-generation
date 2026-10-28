'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { api, cx, money } from '@/lib/client';
import { chosenFile, fileUrl, testPages, type Book, type CastStep, type Person, type Run, type RunStep } from '@/lib/types';

import { BookFonts, BookPage } from '../BookPage';
import { BackIcon, BookIcon, CheckIcon, RedoIcon } from '../icons';
import { BeforeAfter } from '../run/BeforeAfter';
import { Flipbook } from '../run/Flipbook';
import run$ from '../run/RunView.module.css';
import ui from '../ui.module.css';
import styles from './Preview.module.css';

const POLL_MS = 2000;

const busyStep = (s: RunStep) => s.status === 'queued' || s.status === 'working';

/**
 * The customer's side of a run: check the drawings, see the preview pages (watermarked), order
 * the full book. The owner's tools for the same run (versions, fixes, costs) are on /runs/<id>.
 */
export function Preview({ initial, book, people, price }: { initial: Run; book: Book; people: Person[]; price: number }) {
  const [run, setRun] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const polling = run.cast.some((c) => !c.approved && busyStep(c)) || Object.values(run.pages).some(busyStep);

  const refresh = useCallback(async () => {
    try {
      setRun(await api<Run>(`/api/runs/${run.id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [run.id]);

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  async function act(url: string, body: object, method = 'POST') {
    setError(null);
    try {
      setRun(await api<Run>(url, { method, json: body }));
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
  const watermark = !run.ordered;
  const who = run.cast.map((c) => personOf(c)?.name ?? 'someone').join(' & ');
  const names: [string, string][] = run.cast
    .map((c) => [characterOf(c.characterId)?.nameInText.trim() ?? '', personOf(c)?.name ?? ''] as [string, string])
    .filter(([from, to]) => from && to);

  // What ordering adds: every other page with these characters, one image per character on it.
  const rest = testPages(book, 'all', castIds).filter((i) => !run.pages[i]);
  const restImages = rest.reduce((n, i) => n + castIds.filter((id) => book.pages.find((p) => p.index === i)?.cast[id]?.present).length, 0);

  async function order() {
    const note = `Local demo, no payment. This draws the other ${rest.length} pages: about ${restImages} images, ${money(restImages * price)} of AI.`;
    if (!window.confirm(note)) return;
    await act(`/api/runs/${run.id}`, { order: true }, 'PATCH');
  }

  async function deletePhotos() {
    if (!window.confirm(`Delete the photos of ${who} and the drawings made from them? This book stays.`)) return;
    setError(null);
    try {
      await Promise.all(run.cast.map((c) => api(`/api/people/${c.personId}?photo=1`, { method: 'DELETE' })));
      setDeleted(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className={styles.layout}>
      <BookFonts book={book} />

      <header className={styles.head}>
        <Link href="/" className={cx(ui.btn, ui.ghost, ui.small)}>
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
                      onClick={() =>
                        act(`/api/runs/${run.id}/character`, {
                          action: 'regenerate',
                          characterId: step.characterId,
                        })
                      }
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
            <button className={cx(ui.btn, ui.primary)} onClick={() => act(`/api/runs/${run.id}/character`, { action: 'approve' })} disabled={!canApprove}>
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
                    after={<BookPage book={book} page={page} art={file} names={names} className={cx(watermark && ui.watermark)} />}
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
                    onClick={() =>
                      act(`/api/runs/${run.id}/pages/${page.index}`, {
                        action: 'regenerate',
                      })
                    }
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

      {!run.ordered && rest.length > 0 && (
        <section className={cx(ui.panel, styles.order)}>
          <div className={styles.orderText}>
            <h2 className={ui.panelTitle}>Like it? Order the whole book</h2>
            {/* On a pastel wash, text stays ink (style guide §1.5). */}
            <p>
              All {rest.length + pages.length} pages with {who}, without the watermark. You see every page before it is printed.
            </p>
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

      {reading && <Flipbook book={book} run={run} names={names} watermark={watermark} onClose={() => setReading(false)} />}
    </main>
  );
}
