'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { api, cx, money, seconds } from '@/lib/client';
import { fileUrl, type Book, type Child, type Run, type RunStep } from '@/lib/types';

import { BookFonts, BookPage } from '../BookPage';
import { BackIcon, BookIcon, CheckIcon, RedoIcon, TrashIcon } from '../icons';
import ui from '../ui.module.css';
import { BeforeAfter } from './BeforeAfter';
import { Flipbook } from './Flipbook';
import styles from './RunView.module.css';

const POLL_MS = 2000;

const chosen = (step: RunStep) => step.attempts[step.selected ?? step.attempts.length - 1]?.file ?? null;

const active = (run: Run) =>
  ['queued', 'working'].includes(run.character.status) || Object.values(run.pages).some((s) => s.status === 'queued' || s.status === 'working');

export function RunView({ initial, book, child, price }: { initial: Run; book: Book; child: Child | null; price: number }) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const polling = active(run);

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

  async function act(url: string, body: object) {
    setError(null);
    try {
      setRun(await api<Run>(url, { method: 'POST', json: body }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this run and its generated images?')) return;
    await api(`/api/runs/${run.id}`, { method: 'DELETE' });
    router.push('/');
  }

  const c = run.character;
  const characterFile = chosen(c);
  const pages = run.pageIndexes.map((i) => book.pages.find((p) => p.index === i)).filter((p) => !!p);
  const done = pages.filter((p) => run.pages[p.index]?.status === 'done').length;
  const name = child?.name ?? null;

  return (
    <main className={styles.layout}>
      <BookFonts book={book} />

      <header className={styles.head}>
        <Link href="/" className={cx(ui.btn, ui.ghost, ui.small)}>
          <BackIcon />
          Library
        </Link>
        <div className={styles.titles}>
          <h1 className={styles.title}>
            {book.title} <span className={styles.with}>with</span> {name ?? 'a deleted child'}
          </h1>
          <span className={ui.muted}>
            {run.images} {run.images === 1 ? 'image' : 'images'} generated · {money(run.images * price)}
          </span>
        </div>
        <StatusChip run={run} done={done} total={pages.length} />
        <button className={cx(ui.btn, ui.secondary)} onClick={() => setReading(true)} disabled={done === 0}>
          <BookIcon />
          Book view
        </button>
        <button className={ui.iconBtn} onClick={remove} aria-label="Delete run" title="Delete run">
          <TrashIcon />
        </button>
      </header>

      {error && (
        <p className={cx(ui.notice, ui.noticeError)}>
          <span className={ui.dot} />
          {error}
        </p>
      )}

      {/* Step 1 */}
      <section className={cx(ui.panel, styles.character)}>
        <div className={styles.charImages}>
          <figure className={styles.photo}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {child?.photo ? <img src={fileUrl(child.photo)} alt={`Photo of ${child.name}`} /> : <span className={ui.muted}>No photo</span>}
            <figcaption>Photo</figcaption>
          </figure>
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
          <figure className={styles.drawing}>
            {characterFile ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl(characterFile)} alt={`${name ?? 'The child'} drawn in the book's style`} />
            ) : (
              <span className={styles.placeholder}>{c.status === 'error' ? 'No drawing' : <span className={ui.spinner} />}</span>
            )}
            {c.status === 'working' && characterFile && (
              <span className={styles.working}>
                <span className={ui.spinner} />
              </span>
            )}
            <figcaption>In the book&apos;s style</figcaption>
          </figure>
        </div>

        <div className={styles.charText}>
          <span className={ui.eyebrow}>Step 1 · Character</span>
          <h2 className={ui.panelTitle}>
            {c.approved ? 'Character approved' : c.status === 'working' || c.status === 'queued' ? 'Drawing the character…' : 'Does this look like the child?'}
          </h2>
          <p className={ui.muted}>
            {c.reused
              ? 'Reused the drawing approved earlier for this book.'
              : c.approved
                ? 'Every page copies this drawing, so the child looks the same throughout.'
                : 'Every page will copy this drawing. Approve it, or draw it again. Pages start only after you approve.'}
          </p>
          {c.message && (
            <p className={cx(ui.notice, ui.noticeInfo)}>
              <span className={ui.dot} />
              {c.message}
            </p>
          )}
          {c.status === 'error' && (
            <p className={cx(ui.notice, ui.noticeError)}>
              <span className={ui.dot} />
              {c.message ?? 'The drawing failed.'}
            </p>
          )}

          {c.attempts.length > 1 && (
            <div className={styles.attempts} role="group" aria-label="Character attempts">
              {c.attempts.map((a, i) => (
                <button
                  key={a.file}
                  className={cx(styles.attempt, (c.selected ?? c.attempts.length - 1) === i && styles.attemptOn)}
                  onClick={() => act(`/api/runs/${run.id}/character`, { action: 'select', attempt: i })}
                  disabled={c.approved}
                  aria-pressed={(c.selected ?? c.attempts.length - 1) === i}
                  aria-label={`Attempt ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(a.file)} alt="" />
                </button>
              ))}
            </div>
          )}

          {!c.approved && (characterFile || c.status === 'error') && (
            <div className={ui.row}>
              <button
                className={cx(ui.btn, ui.primary)}
                onClick={() => act(`/api/runs/${run.id}/character`, { action: 'approve' })}
                disabled={!characterFile || c.status === 'working'}
              >
                <CheckIcon />
                Approve and make {pages.length} {pages.length === 1 ? 'page' : 'pages'}
              </button>
              <button
                className={cx(ui.btn, ui.secondary)}
                onClick={() => act(`/api/runs/${run.id}/character`, { action: 'regenerate' })}
                disabled={c.status === 'working' || c.status === 'queued'}
              >
                <RedoIcon />
                Draw again
              </button>
            </div>
          )}
          {c.attempts.at(-1) && <span className={ui.help}>Last drawing took {seconds(c.attempts.at(-1)!.ms)}</span>}
        </div>
      </section>

      {/* Step 2 */}
      <section className={styles.pagesSection}>
        <div className={styles.sectionHead}>
          <span className={ui.eyebrow}>Step 2 · Pages</span>
          <span className={ui.muted}>
            {done}/{pages.length} done · drag across a page to compare
          </span>
        </div>
        <ul className={styles.pages}>
          {pages.map((page) => {
            const step = run.pages[page.index];
            const file = chosen(step);
            const label = page.kind === 'cover' ? 'Cover' : `Page ${page.index}`;
            return (
              <li key={page.index} className={cx(styles.pageCard, book.pageWidth > book.pageHeight && styles.pageCardWide)}>
                <div className={styles.pageHead}>
                  <strong>{label}</strong>
                  <StepChip step={step} />
                  {step.attempts.at(-1) && <span className={styles.time}>{seconds(step.attempts.at(-1)!.ms)}</span>}
                </div>

                {file ? (
                  <BeforeAfter
                    label={label}
                    before={<BookPage book={book} page={page} />}
                    after={<BookPage book={book} page={page} art={file} name={name} />}
                  />
                ) : (
                  <div className={styles.pending}>
                    <BookPage book={book} page={page} />
                    <span className={styles.pendingVeil}>
                      {step.status === 'working' && <span className={ui.spinner} />}
                      {step.status === 'waiting' && 'Waits for the character'}
                      {step.status === 'queued' && 'In the queue'}
                      {step.status === 'working' && (step.message ?? 'Drawing…')}
                      {step.status === 'error' && 'Failed'}
                    </span>
                  </div>
                )}

                {step.status === 'error' && step.message && (
                  <p className={cx(ui.notice, ui.noticeError)}>
                    <span className={ui.dot} />
                    {step.message}
                  </p>
                )}
                {step.status === 'working' && file && <p className={cx(ui.help, styles.redrawing)}>{step.message ?? 'Drawing a new version…'}</p>}

                <div className={styles.pageFoot}>
                  {step.attempts.length > 1 && (
                    <div className={styles.versions} role="group" aria-label={`${label} versions`}>
                      {step.attempts.map((a, i) => (
                        <button
                          key={a.file}
                          className={cx(styles.version, (step.selected ?? step.attempts.length - 1) === i && styles.versionOn)}
                          onClick={() => act(`/api/runs/${run.id}/pages/${page.index}`, { action: 'select', attempt: i })}
                          aria-pressed={(step.selected ?? step.attempts.length - 1) === i}
                        >
                          {i + 1}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    className={cx(ui.btn, ui.secondary, ui.small, styles.redo)}
                    onClick={() => act(`/api/runs/${run.id}/pages/${page.index}`, { action: 'regenerate' })}
                    disabled={!c.approved || step.status === 'working' || step.status === 'queued'}
                  >
                    <RedoIcon />
                    {step.attempts.length ? 'Regenerate' : 'Try again'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {reading && <Flipbook book={book} run={run} name={name} onClose={() => setReading(false)} />}
    </main>
  );
}

function StatusChip({ run, done, total }: { run: Run; done: number; total: number }) {
  if (run.status === 'done') return <span className={cx(ui.chip, ui.sage)}>Done</span>;
  if (run.status === 'review') return <span className={cx(ui.chip, ui.butter)}>Check the character</span>;
  if (run.status === 'character') return <span className={cx(ui.chip, ui.lilac)}>Drawing character</span>;
  return (
    <span className={cx(ui.chip, ui.sky)}>
      Pages {done}/{total}
    </span>
  );
}

function StepChip({ step }: { step: RunStep }) {
  const map: Record<RunStep['status'], [string, string]> = {
    waiting: ['Waiting', ''],
    queued: ['Queued', ui.sky],
    working: ['Drawing', ui.lilac],
    done: ['Done', ui.sage],
    error: ['Failed', ui.peach],
  };
  const [text, tone] = map[step.status];
  return <span className={cx(ui.chip, tone)}>{text}</span>;
}
