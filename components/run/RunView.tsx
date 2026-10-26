'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { api, cx, money, seconds } from '@/lib/client';
import { chosenFile, FIX_MAX, fileUrl, presentOn, type Attempt, type Book, type CastStep, type Person, type Run, type RunStep } from '@/lib/types';

import { BookFonts, BookPage } from '../BookPage';
import { BackIcon, BookIcon, CheckIcon, RedoIcon, TrashIcon } from '../icons';
import ui from '../ui.module.css';
import { BeforeAfter } from './BeforeAfter';
import { Flipbook } from './Flipbook';
import styles from './RunView.module.css';

const POLL_MS = 2000;

const chosen = (step: RunStep) => chosenFile(step);

const busyStep = (s: RunStep) => s.status === 'queued' || s.status === 'working';

const active = (run: Run) => run.cast.some((c) => !c.approved && busyStep(c)) || Object.values(run.pages).some(busyStep);

export function RunView({ initial, book, people, price }: { initial: Run; book: Book; people: Person[]; price: number }) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  /** Correction typed under each page, by page index; sent with its next Regenerate. */
  const [fixes, setFixes] = useState<Record<number, string>>({});
  /** Which character a page's correction is for ('' = everyone on the page). */
  const [fixFor, setFixFor] = useState<Record<number, string>>({});
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

  async function regenerate(index: number) {
    await act(`/api/runs/${run.id}/pages/${index}`, { action: 'regenerate', fix: fixes[index] ?? '', fixFor: fixFor[index] || null });
    setFixes((f) => ({ ...f, [index]: '' }));
  }

  async function switchTogether(together: boolean) {
    setError(null);
    try {
      setRun(await api<Run>(`/api/runs/${run.id}`, { method: 'PATCH', json: { together } }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this run and its generated images?')) return;
    await api(`/api/runs/${run.id}`, { method: 'DELETE' });
    router.push('/');
  }

  const personOf = (step: CastStep) => people.find((p) => p.id === step.personId) ?? null;
  const characterOf = (id: string) => book.characters.find((c) => c.id === id);
  const pages = run.pageIndexes.map((i) => book.pages.find((p) => p.index === i)).filter((p) => !!p);
  const done = pages.filter((p) => run.pages[p.index]?.status === 'done').length;
  const approved = run.cast.every((c) => c.approved);
  const drawing = run.cast.some((c) => !c.approved && busyStep(c));
  const canApprove = !approved && !drawing && run.cast.every((c) => chosen(c));
  /** Name swaps for the page text: each character's name in the book → their person's name. */
  const names: [string, string][] = run.cast
    .map((c) => [characterOf(c.characterId)?.nameInText.trim() ?? '', personOf(c)?.name ?? ''] as [string, string])
    .filter(([from, to]) => from && to);
  const who = run.cast.map((c) => personOf(c)?.name ?? 'a deleted person').join(' & ');

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
            {book.title} <span className={styles.with}>with</span> {who}
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
      <section className={cx(ui.panel, styles.castSection)}>
        <div className={styles.castHead}>
          <div className={styles.charText}>
            <span className={ui.eyebrow}>Step 1 · People in the book&apos;s style</span>
            <h2 className={ui.panelTitle}>
              {approved ? 'Drawings approved' : drawing ? 'Drawing everyone…' : 'Do these look like them?'}
            </h2>
            <p className={ui.muted}>
              {approved
                ? 'Every page copies these drawings, so everyone looks the same throughout.'
                : 'Every page will copy these drawings. Draw any of them again, then approve. Pages start only after you approve.'}
            </p>
          </div>
          {!approved && (
            <button className={cx(ui.btn, ui.primary)} onClick={() => act(`/api/runs/${run.id}/character`, { action: 'approve' })} disabled={!canApprove}>
              <CheckIcon />
              Approve and make {pages.length} {pages.length === 1 ? 'page' : 'pages'}
            </button>
          )}
        </div>

        <ul className={styles.castCards}>
          {run.cast.map((step) => {
            const person = personOf(step);
            const character = characterOf(step.characterId);
            const file = chosen(step);
            return (
              <li key={step.characterId} className={styles.castCard}>
                <div className={styles.charImages}>
                  <figure className={styles.photo}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {person?.photo ? <img src={fileUrl(person.photo)} alt={`Photo of ${person.name}`} /> : <span className={ui.muted}>No photo</span>}
                    <figcaption>{person?.name ?? 'Deleted person'}</figcaption>
                  </figure>
                  <span className={styles.arrow} aria-hidden="true">
                    →
                  </span>
                  <figure className={styles.drawing}>
                    {file ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={fileUrl(file)} alt={`${person?.name ?? 'Person'} drawn as ${character?.label ?? 'a character'}`} />
                    ) : (
                      <span className={styles.placeholder}>{step.status === 'error' ? 'No drawing' : <span className={ui.spinner} />}</span>
                    )}
                    {step.status === 'working' && file && (
                      <span className={styles.working}>
                        <span className={ui.spinner} />
                      </span>
                    )}
                    <figcaption>as {character?.label ?? 'a removed character'}</figcaption>
                  </figure>
                </div>
                {step.reused && <span className={cx(ui.chip, ui.sage)}>Reused from an earlier run</span>}
                {step.message && (
                  <p className={cx(ui.notice, step.status === 'error' ? ui.noticeError : ui.noticeInfo)}>
                    <span className={ui.dot} />
                    {step.message}
                  </p>
                )}
                {step.attempts.length > 1 && (
                  <div className={styles.attempts} role="group" aria-label={`${person?.name ?? ''} attempts`}>
                    {step.attempts.map((a, i) => (
                      <button
                        key={a.file}
                        className={cx(styles.attempt, (step.selected ?? step.attempts.length - 1) === i && styles.attemptOn)}
                        onClick={() => act(`/api/runs/${run.id}/character`, { action: 'select', characterId: step.characterId, attempt: i })}
                        disabled={step.approved}
                        aria-pressed={(step.selected ?? step.attempts.length - 1) === i}
                        aria-label={`Attempt ${i + 1}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fileUrl(a.file)} alt="" />
                      </button>
                    ))}
                  </div>
                )}
                {!step.approved && (file || step.status === 'error') && (
                  <button
                    className={cx(ui.btn, ui.secondary, ui.small)}
                    onClick={() => act(`/api/runs/${run.id}/character`, { action: 'regenerate', characterId: step.characterId })}
                    disabled={busyStep(step)}
                  >
                    <RedoIcon />
                    Draw again
                  </button>
                )}
                {step.attempts.at(-1) && !step.reused && <span className={ui.help}>Took {seconds(step.attempts.at(-1)!.ms)}</span>}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Step 2 */}
      <section className={styles.pagesSection}>
        <div className={styles.sectionHead}>
          <span className={ui.eyebrow}>Step 2 · Pages</span>
          {run.cast.length > 1 && (
            <div className={cx(ui.segmented, styles.modeSwitch)} role="group" aria-label="How characters on a page are drawn">
              <button className={ui.segment} aria-pressed={!run.together} onClick={() => switchTogether(false)} title="One image per character: best detail">
                One by one
              </button>
              <button className={ui.segment} aria-pressed={!!run.together} onClick={() => switchTogether(true)} title="One image per page for everyone: cheaper, faces smaller">
                All at once
              </button>
            </div>
          )}
          <span className={ui.muted}>
            {done}/{pages.length} done · drag across a page to compare
          </span>
        </div>
        <ul className={styles.pages}>
          {pages.map((page) => {
            const step = run.pages[page.index];
            const file = chosen(step);
            const shown = step.attempts[step.selected ?? step.attempts.length - 1] as Attempt | undefined;
            const onPage = presentOn(book, page).filter((c) => run.cast.some((m) => m.characterId === c.id));
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
                    after={<BookPage book={book} page={page} art={file} names={names} />}
                  />
                ) : (
                  <div className={styles.pending}>
                    <BookPage book={book} page={page} />
                    <span className={styles.pendingVeil}>
                      {step.status === 'working' && <span className={ui.spinner} />}
                      {step.status === 'waiting' && 'Waits for the drawings'}
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

                {file && shown?.fix && (
                  <p className={cx(ui.help, styles.madeWith)}>
                    Made with: “{shown.fix}”
                  </p>
                )}

                {(step.attempts.length > 0 || step.status === 'error') && onPage.length > 1 && (
                  <div className={ui.segmented} role="group" aria-label={`Who the fix for ${label} is for`}>
                    <button className={ui.segment} aria-pressed={!fixFor[page.index]} onClick={() => setFixFor((f) => ({ ...f, [page.index]: '' }))}>
                      Everyone
                    </button>
                    {onPage.map((c) => (
                      <button key={c.id} className={ui.segment} aria-pressed={fixFor[page.index] === c.id} onClick={() => setFixFor((f) => ({ ...f, [page.index]: c.id }))}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
                {(step.attempts.length > 0 || step.status === 'error') && (
                  <label className={styles.fix}>
                    <span className={ui.srOnly}>Optional correction for {label}</span>
                    <input
                      className={cx(ui.input, styles.fixInput)}
                      value={fixes[page.index] ?? ''}
                      maxLength={FIX_MAX}
                      onChange={(e) => setFixes((f) => ({ ...f, [page.index]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && approved && step.status !== 'working' && step.status !== 'queued') void regenerate(page.index);
                      }}
                      placeholder="Optional fix, e.g. facing away from us, like the original"
                      disabled={step.status === 'working' || step.status === 'queued'}
                    />
                    {(fixes[page.index]?.length ?? 0) > 0 && (
                      <span className={styles.fixCount}>
                        {fixes[page.index].length}/{FIX_MAX}
                      </span>
                    )}
                  </label>
                )}

                <div className={styles.pageFoot}>
                  {step.attempts.length > 1 && (
                    <div className={styles.versions} role="group" aria-label={`${label} versions`}>
                      {step.attempts.map((a, i) => (
                        <button
                          key={a.file}
                          className={cx(styles.version, (step.selected ?? step.attempts.length - 1) === i && styles.versionOn)}
                          onClick={() => act(`/api/runs/${run.id}/pages/${page.index}`, { action: 'select', attempt: i })}
                          aria-pressed={(step.selected ?? step.attempts.length - 1) === i}
                          title={[`Version ${i + 1}`, a.together && 'all at once', a.fix && `fix: “${a.fix}”`].filter(Boolean).join(' · ')}
                        >
                          {i + 1}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    className={cx(ui.btn, ui.secondary, ui.small, styles.redo)}
                    onClick={() => regenerate(page.index)}
                    disabled={!approved || step.status === 'working' || step.status === 'queued'}
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

      {reading && <Flipbook book={book} run={run} names={names} onClose={() => setReading(false)} />}
    </main>
  );
}

function StatusChip({ run, done, total }: { run: Run; done: number; total: number }) {
  if (run.status === 'done') return <span className={cx(ui.chip, ui.sage)}>Done</span>;
  if (run.status === 'review') return <span className={cx(ui.chip, ui.butter)}>Check the drawings</span>;
  if (run.status === 'character') return <span className={cx(ui.chip, ui.lilac)}>Drawing people</span>;
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
