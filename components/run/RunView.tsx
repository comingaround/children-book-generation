'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { cx, money, seconds } from '@/lib/client';
import { publishExample } from '@/lib/local/examples';
import { downloadPdf } from '@/lib/local/pdf';
import { approveCast, regenerateCharacter, regeneratePage, retryText, selectCharacter, selectPageAttempt, setTogether } from '@/lib/local/runner';
import { deleteRun } from '@/lib/local/store';
import { canDrawTogether, chosenFile, chosenIndex, FIX_MAX, fileUrl, presentOn, type Book, type CastStep, type Person, type Run, type RunStep } from '@/lib/types';

import { BookFonts, BookPage } from '../BookPage';
import { BackIcon, BookIcon, CheckIcon, RedoIcon, TrashIcon } from '../icons';
import { RunStatusChip } from '../RunStatusChip';
import { TogetherSwitch } from '../TogetherSwitch';
import ui from '../ui.module.css';
import { BeforeAfter } from './BeforeAfter';
import { Flipbook } from './Flipbook';
import { LocalRun } from './LocalRun';
import styles from './RunView.module.css';

const busyStep = (s: RunStep) => s.status === 'queued' || s.status === 'working';

const drawingCast = (run: Run) => run.cast.some((c) => !c.approved && busyStep(c));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the paid images went on: "2 drawings · 8 page images", plus drawings reused for free. */
function imageBreakdown(run: Run): string {
  const reused = run.cast.filter((c) => c.attempts.some((a) => /-saved\.\w+$/.test(a.file))).length;
  const parts =
    run.drawings === undefined
      ? [`${plural(run.images, 'image')} generated`]
      : [plural(run.drawings, 'drawing'), plural(run.images - run.drawings, 'page image')];
  if (reused) parts.push(`${reused} saved ${reused === 1 ? 'drawing' : 'drawings'} reused free`);
  return parts.join(' · ');
}

/** `serverPdf`: published books' PDFs are made by the server (the local version, with Python). */
export function RunView({ id, price, serverPdf }: { id: string; price: number; serverPdf: boolean }) {
  return (
    <LocalRun id={id} back="/studio">
      {(loaded) => <RunBody {...loaded} price={price} serverPdf={serverPdf} />}
    </LocalRun>
  );
}

function RunBody({ run, book, people, price, serverPdf }: { run: Run; book: Book; people: Person[]; price: number; serverPdf: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'pdf' | 'print' | 'example' | null>(null);
  const [published, setPublished] = useState(false);
  const [reading, setReading] = useState(false);
  /** Correction typed under each page, by page index; sent with its next Regenerate. */
  const [fixes, setFixes] = useState<Record<number, string>>({});
  /** Which character a page's correction is for ('' = everyone on the page). */
  const [fixFor, setFixFor] = useState<Record<number, string>>({});

  /** A change to the run; the page updates from storage once it is saved. */
  async function act(change: () => Promise<unknown>) {
    setError(null);
    try {
      await change();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function regenerate(index: number) {
    await act(() => regeneratePage(run.id, index, fixes[index] ?? '', fixFor[index] || null));
    setFixes((f) => ({ ...f, [index]: '' }));
  }

  async function remove() {
    if (!window.confirm('Delete this run and its generated images?')) return;
    await act(() => deleteRun(run.id));
    router.push('/studio');
  }

  /** The owner, locally: keeps this finished run with the site as an example (next deploy). */
  async function publish() {
    if (!window.confirm('Publish this run as an example? Its pages, the photos of everyone in it and its PDF go online with the next deploy.')) return;
    setSaving('example');
    await act(async () => {
      await publishExample(book, run, people);
      setPublished(true);
    });
    setSaving(null);
  }

  async function savePdf(print: boolean) {
    setSaving(print ? 'print' : 'pdf');
    await act(() => downloadPdf(book, run, names, print, serverPdf));
    setSaving(null);
  }

  const personOf = (step: CastStep) => people.find((p) => p.id === step.personId) ?? null;
  const characterOf = (id: string) => book.characters.find((c) => c.id === id);
  const pages = run.pageIndexes.map((i) => book.pages.find((p) => p.index === i)).filter((p) => !!p);
  const done = pages.filter((p) => run.pages[p.index]?.status === 'done').length;
  const approved = run.cast.every((c) => c.approved);
  const drawing = drawingCast(run);
  const canApprove = !approved && !drawing && run.cast.every((c) => chosenFile(c));
  const castIds = run.cast.map((c) => c.characterId);
  /** Name swaps for the page text: each character's name in the book → their person's name. */
  const names: [string, string][] = run.cast
    .map((c) => [characterOf(c.characterId)?.nameInText.trim() ?? '', personOf(c)?.name ?? ''] as [string, string])
    .filter(([from, to]) => from && to);
  const who = run.cast.map((c) => personOf(c)?.name ?? 'a deleted person').join(' & ');

  return (
    <main className={styles.layout}>
      <BookFonts book={book} />

      <header className={styles.head}>
        <Link href="/studio" className={cx(ui.btn, ui.ghost, ui.small, ui.back)}>
          <BackIcon />
          Books
        </Link>
        <div className={styles.titles}>
          <h1 className={styles.title}>
            {book.title} <span className={styles.with}>with</span> {who}
          </h1>
          <span className={ui.muted}>
            {imageBreakdown(run)} · {money(run.images * price)}
          </span>
        </div>
        <div className={styles.actions}>
          <RunStatusChip status={run.status} done={done} total={pages.length} />
          <Link href={`/preview/${run.id}`} className={cx(ui.btn, ui.ghost, ui.small)}>
            Customer view
          </Link>
          <button className={cx(ui.btn, ui.ghost, ui.small)} onClick={() => savePdf(false)} disabled={!!saving}>
            {saving === 'pdf' && <span className={ui.spinner} />}
            PDF
          </button>
          <button className={cx(ui.btn, ui.ghost, ui.small)} onClick={() => savePdf(true)} disabled={!!saving} title="300 dpi art and 3 mm bleed, for a printer">
            {saving === 'print' && <span className={ui.spinner} />}
            Print PDF
          </button>
          {serverPdf && !book.local && run.status === 'done' && done === pages.length && (
            <button className={cx(ui.btn, ui.ghost, ui.small)} onClick={publish} disabled={!!saving || published} title="Keep this finished book with the site, for visitors to see">
              {saving === 'example' && <span className={ui.spinner} />}
              {published ? 'Published as example' : 'Publish as example'}
            </button>
          )}
          <button className={cx(ui.btn, ui.secondary)} onClick={() => setReading(true)} disabled={done === 0}>
            <BookIcon />
            Book view
          </button>
          <button className={ui.iconBtn} onClick={remove} aria-label="Delete run" title="Delete run">
            <TrashIcon />
          </button>
        </div>
      </header>

      {error && (
        <p className={cx(ui.notice, ui.noticeError)}>
          <span className={ui.dot} />
          {error}
        </p>
      )}

      {run.textStatus === 'working' && (
        <p className={cx(ui.notice, ui.noticeInfo)}>
          <span className={ui.dot} />
          Rewriting he/she in the text for the new gender…
        </p>
      )}
      {run.textStatus === 'error' && (
        <p className={cx(ui.notice, ui.noticeError)}>
          <span className={ui.dot} />
          The he/she rewrite failed; pages show the names swapped only.
          <button className={cx(ui.btn, ui.ghost, ui.small)} onClick={() => act(() => retryText(run.id))}>
            Try the text again
          </button>
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
            <button className={cx(ui.btn, ui.primary)} onClick={() => act(() => approveCast(run.id))} disabled={!canApprove}>
              <CheckIcon />
              Approve and make {pages.length} {pages.length === 1 ? 'page' : 'pages'}
            </button>
          )}
        </div>

        <ul className={styles.castCards}>
          {run.cast.map((step) => {
            const person = personOf(step);
            const character = characterOf(step.characterId);
            const file = chosenFile(step);
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
                        className={cx(styles.attempt, chosenIndex(step) === i && styles.attemptOn)}
                        onClick={() => act(() => selectCharacter(run.id, step.characterId, i))}
                        disabled={step.approved}
                        aria-pressed={chosenIndex(step) === i}
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
                    onClick={() => act(() => regenerateCharacter(run.id, step.characterId))}
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
            <TogetherSwitch
              className={styles.modeSwitch}
              together={!!run.together}
              onChange={(together) => act(() => setTogether(run.id, together))}
            />
          )}
          <span className={ui.muted}>
            {done}/{pages.length} done · drag across a page to compare
          </span>
        </div>
        <ul className={styles.pages}>
          {pages.map((page) => {
            const step = run.pages[page.index];
            const file = chosenFile(step);
            const shown = step.attempts.at(chosenIndex(step));
            const onPage = presentOn(book, page).filter((c) => castIds.includes(c.id));
            const label = page.kind === 'cover' ? 'Cover' : `Page ${page.index}`;
            const busy = busyStep(step);
            const canFix = step.attempts.length > 0 || step.status === 'error';
            // "All at once" quietly becomes one by one when someone on the page has no box.
            const fallsBack = !!run.together && onPage.length > 1 && !canDrawTogether(book, page, castIds);
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
                    after={<BookPage book={book} page={page} art={file} names={names} texts={run.text?.[page.index]} />}
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
                    Made with{shown.fixFor ? ` (for ${characterOf(shown.fixFor)?.label ?? 'one character'})` : ''}: “{shown.fix}”
                  </p>
                )}
                {fallsBack && <p className={ui.help}>Drawn one by one: not everyone on this page has a box.</p>}

                {canFix && onPage.length > 1 && (
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
                {canFix && (
                  <label className={styles.fix}>
                    <span className={ui.srOnly}>Optional correction for {label}</span>
                    <input
                      className={cx(ui.input, styles.fixInput)}
                      value={fixes[page.index] ?? ''}
                      maxLength={FIX_MAX}
                      onChange={(e) => setFixes((f) => ({ ...f, [page.index]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && approved && !busy) void regenerate(page.index);
                      }}
                      placeholder="Optional fix, e.g. facing away from us"
                      disabled={busy}
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
                          className={cx(styles.version, chosenIndex(step) === i && styles.versionOn)}
                          onClick={() => act(() => selectPageAttempt(run.id, page.index, i))}
                          aria-pressed={chosenIndex(step) === i}
                          title={[`Version ${i + 1}`, a.together && 'all at once', a.fix && `fix${a.fixFor ? ` for ${characterOf(a.fixFor)?.label ?? 'one character'}` : ''}: “${a.fix}”`]
                            .filter(Boolean)
                            .join(' · ')}
                        >
                          {i + 1}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    className={cx(ui.btn, ui.secondary, ui.small, styles.redo)}
                    onClick={() => regenerate(page.index)}
                    disabled={!approved || busy}
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
