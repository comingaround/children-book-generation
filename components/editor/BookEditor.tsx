'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';

import type { BookDraft, PageDraft } from '@/lib/ai/prompts';
import { api, cx } from '@/lib/client';
import { fileUrl, pageState, type Book, type BookSettings, type Box, type Page, type PageKind } from '@/lib/types';

import { BookFonts, BookPage } from '../BookPage';
import { GrowField } from '../GrowField';
import { BackIcon, SparkIcon, TrashIcon } from '../icons';
import ui from '../ui.module.css';
import { BoxEditor } from './BoxEditor';
import styles from './BookEditor.module.css';

type SaveState = 'saved' | 'saving' | 'error';

const DOT: Record<ReturnType<typeof pageState>, string> = {
  ready: ui.dotOk,
  needsBox: ui.dotWarn,
  noHero: ui.dotInfo,
  skip: '',
};

const STATE_LABEL: Record<ReturnType<typeof pageState>, string> = {
  ready: 'Ready',
  needsBox: 'Main character needs a box',
  noHero: 'No main character, kept as is',
  skip: 'Skipped',
};

export function BookEditor({ initial }: { initial: Book }) {
  const router = useRouter();
  const [book, setBook] = useState(initial);
  const [current, setCurrent] = useState(initial.pages.find((p) => p.kind !== 'skip')?.index ?? 1);
  const [tab, setTab] = useState<'page' | 'book'>(initial.settings.protagonistName ? 'page' : 'book');
  const [showText, setShowText] = useState(true);
  const [save, setSave] = useState<SaveState>('saved');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);

  const page = book.pages.find((p) => p.index === current) ?? book.pages[0];
  const heroPages = book.pages.filter((p) => ['ready', 'needsBox'].includes(pageState(p)));
  const ready = heroPages.filter((p) => p.box).length;

  // Autosave 600 ms after the last change.
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(async () => {
      setSave('saving');
      try {
        await api(`/api/books/${book.id}`, { method: 'PUT', json: { title: book.title, settings: book.settings, pages: book.pages } });
        setSave('saved');
      } catch {
        setSave('error');
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [book]);

  // Up/down arrows walk the pages when no field has focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      setCurrent((c) => {
        const i = book.pages.findIndex((p) => p.index === c);
        return book.pages[Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), book.pages.length - 1)].index;
      });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [book.pages]);

  function change(fn: (b: Book) => Book) {
    dirty.current = true;
    setBook(fn);
  }
  const setPage = (index: number, patch: Partial<Page>) =>
    change((b) => ({ ...b, pages: b.pages.map((p) => (p.index === index ? { ...p, ...patch } : p)) }));
  const setSettings = (patch: Partial<BookSettings>) => change((b) => ({ ...b, settings: { ...b.settings, ...patch } }));

  /** `onlyEmpty` keeps whatever is already filled in and adds only the missing fields. */
  async function draftBook(onlyEmpty = false): Promise<BookSettings> {
    const draft = await api<BookDraft>(`/api/books/${book.id}/draft`, { method: 'POST', json: {} });
    const current = book.settings as unknown as Record<string, unknown>;
    const patch = onlyEmpty ? Object.fromEntries(Object.entries(draft).filter(([k]) => !current[k])) : draft;
    setSettings(patch);
    return { ...book.settings, ...patch };
  }

  /** Sends the settings on screen, so a name typed a moment ago is used before autosave runs. */
  async function draftPage(target: Page, settings = book.settings) {
    const draft = await api<Omit<PageDraft, 'box'> & { box: Box | null }>(`/api/books/${book.id}/draft`, {
      method: 'POST',
      json: { index: target.index, settings },
    });
    setPage(target.index, {
      hasProtagonist: draft.hasProtagonist,
      characterHint: draft.characterHint,
      pose: draft.pose,
      clothing: draft.clothingDiffers ? draft.clothing : '',
      scenePrompt: draft.scenePrompt,
      // Never replace a box someone drew by hand.
      ...(draft.box && !target.box ? { box: draft.box } : {}),
    });
  }

  async function withBusy(label: string, task: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** Book settings first (the page prompts use the hero's name), then every unprepared page. */
  const draftAll = () =>
    withBusy('all', async () => {
      try {
        let settings = book.settings;
        if (!settings.protagonistName || !settings.clothing) {
          setProgress('Reading the book…');
          settings = await draftBook(true);
        }
        const todo = book.pages.filter((p) => p.kind !== 'skip' && (!p.box || !p.scenePrompt || (p.hasProtagonist && !p.pose)));
        for (const [i, p] of todo.entries()) {
          setProgress(`Drafting page ${i + 1} of ${todo.length}…`);
          setCurrent(p.index);
          await draftPage(p, settings);
        }
      } finally {
        setProgress(null);
      }
    });

  async function deleteBook() {
    if (!window.confirm(`Delete "${book.title}" and its imported pages? Runs made from it will stop opening.`)) return;
    await withBusy('delete', async () => {
      await api(`/api/books/${book.id}`, { method: 'DELETE' });
      router.push('/');
    });
  }

  const name = book.settings.protagonistName.trim();

  return (
    <main className={styles.layout}>
      <BookFonts book={book} />

      <header className={styles.head}>
        <Link href="/" className={cx(ui.btn, ui.ghost, ui.small)}>
          <BackIcon />
          Library
        </Link>
        <input
          className={styles.title}
          value={book.title}
          onChange={(e) => change((b) => ({ ...b, title: e.target.value }))}
          aria-label="Book title"
        />
        <span className={cx(ui.chip, ready === heroPages.length ? ui.sage : ui.peach)}>
          {ready}/{heroPages.length} main-character pages ready
        </span>
        <span className={styles.save} aria-live="polite">
          {save === 'saving' ? 'Saving…' : save === 'error' ? 'Not saved — retrying on next change' : 'Saved'}
        </span>
        <button
          className={cx(ui.btn, ui.secondary)}
          onClick={draftAll}
          disabled={!!busy}
          title="AI reads the whole book: finds the main character's name, look and the art style, then on every page draws the box around the main character and writes the scene. You check and correct it."
        >
          {busy === 'all' ? <span className={ui.spinner} /> : <SparkIcon />}
          {busy === 'all' ? (progress ?? 'Working…') : 'Prepare all pages with AI'}
        </button>
      </header>

      {error && (
        <p className={cx(ui.notice, ui.noticeError, styles.error)}>
          <span className={ui.dot} />
          {error}
        </p>
      )}

      <div className={styles.columns}>
        <nav className={styles.strip} aria-label="Pages">
          {book.pages.map((p) => {
            const state = pageState(p);
            return (
              <button
                key={p.index}
                className={cx(styles.thumb, p.index === current && styles.thumbOn, state === 'skip' && styles.thumbSkip)}
                onClick={() => setCurrent(p.index)}
                aria-current={p.index === current}
                title={STATE_LABEL[state]}
              >
                <span className={styles.thumbImg} style={{ aspectRatio: `${book.pageWidth} / ${book.pageHeight}` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(`books/${book.id}/${p.thumb}`)} alt="" />
                  <span className={cx(ui.dot, styles.thumbDot, DOT[state])} />
                </span>
                <span className={styles.thumbLabel}>{p.kind === 'cover' ? 'Cover' : `Page ${p.index}`}</span>
              </button>
            );
          })}
        </nav>

        <section className={styles.canvas}>
          <div className={styles.canvasBar}>
            <span className={cx(ui.chip, page.kind === 'skip' ? '' : pageState(page) === 'ready' ? ui.sage : pageState(page) === 'needsBox' ? ui.peach : ui.sky)}>
              {STATE_LABEL[pageState(page)]}
            </span>
            <span className={ui.muted}>
              {page.hasProtagonist && page.kind !== 'skip' ? 'Drag on the picture to draw a box around the main character' : ''}
            </span>
            <label className={cx(ui.switchRow, styles.textToggle)}>
              <span>Show text</span>
              <input type="checkbox" className={ui.switch} checked={showText} onChange={(e) => setShowText(e.target.checked)} />
            </label>
          </div>
          <div className={styles.stage}>
            <BookPage
              book={book}
              page={page}
              showText={showText}
              className={cx(styles.pageView, book.pageWidth > book.pageHeight ? styles.pageWide : styles.pageTall)}
              overlay={
                page.hasProtagonist && page.kind !== 'skip' ? <BoxEditor box={page.box} onChange={(box) => setPage(page.index, { box })} /> : null
              }
            />
          </div>
        </section>

        <aside className={styles.inspector}>
          <div className={ui.segmented} role="group" aria-label="Settings for">
            <button className={ui.segment} aria-pressed={tab === 'page'} onClick={() => setTab('page')}>
              {page.kind === 'cover' ? 'Cover' : `Page ${page.index}`}
            </button>
            <button className={ui.segment} aria-pressed={tab === 'book'} onClick={() => setTab('book')}>
              Book settings
            </button>
          </div>

          {tab === 'page' ? (
            <div className={ui.panel}>
              <div className={ui.section}>
                <div className={ui.field}>
                  <span className={ui.label}>Page type</span>
                  <div className={ui.segmented} role="group" aria-label="Page type">
                    {(['cover', 'page', 'skip'] as PageKind[]).map((k) => (
                      <button key={k} className={ui.segment} aria-pressed={page.kind === k} onClick={() => setPage(page.index, { kind: k })}>
                        {k === 'cover' ? 'Cover' : k === 'page' ? 'Story page' : 'Skip'}
                      </button>
                    ))}
                  </div>
                  <span className={ui.help}>Skipped pages (ads, promo, back cover) are left out of the book.</span>
                </div>
                {page.kind !== 'skip' && (
                  <label className={ui.switchRow}>
                    <span className={styles.switchText}>
                      The main character is on this page
                      <span className={ui.help}>Turn off for pages without them; those pages stay exactly as they are</span>
                    </span>
                    <input
                      type="checkbox"
                      className={ui.switch}
                      checked={page.hasProtagonist}
                      onChange={(e) => setPage(page.index, { hasProtagonist: e.target.checked })}
                    />
                  </label>
                )}
              </div>

              {page.kind !== 'skip' && page.hasProtagonist && (
                <div className={ui.section}>
                  <div className={styles.sectionHead}>
                    <span className={ui.eyebrow}>Main character on this page</span>
                    <button className={cx(ui.btn, ui.secondary, ui.small)} onClick={() => withBusy(`page${page.index}`, () => draftPage(page))} disabled={!!busy}>
                      {busy === `page${page.index}` ? <span className={ui.spinner} /> : <SparkIcon />}
                      Find with AI
                    </button>
                  </div>
                  <span className={ui.help}>
                    The main character is the one replaced by the child: they get the child&apos;s face, hair and skin tone, and keep their clothing and pose.{' '}
                    <strong>Find with AI</strong> looks at this page, draws the box and fills in the fields below; check and correct it.
                  </span>
                  <label className={ui.field}>
                    <span className={ui.label}>Which one is the main character</span>
                    <GrowField
                      rows={1}
                      value={page.characterHint}
                      onChange={(v) => setPage(page.index, { characterHint: v })}
                      placeholder="the boy in the yellow T-shirt on the tricycle, left"
                    />
                  </label>
                  <label className={ui.field}>
                    <span className={ui.label}>Pose and direction (kept)</span>
                    <GrowField
                      value={page.pose ?? ''}
                      onChange={(v) => setPage(page.index, { pose: v })}
                      placeholder="standing, back to the viewer, looking left at the old trike, arms down"
                    />
                    <span className={ui.help}>Which way they face, where they look, what the hands do.</span>
                  </label>
                  <label className={ui.field}>
                    <span className={ui.label}>Clothing on this page (kept)</span>
                    <GrowField
                      rows={1}
                      value={page.clothing ?? ''}
                      onChange={(v) => setPage(page.index, { clothing: v })}
                      placeholder={book.settings.clothing ? `Same as the book: ${book.settings.clothing}` : 'Same as the book'}
                    />
                    <span className={ui.help}>Leave empty when it&apos;s their usual outfit; fill in when this page differs (pyjamas, a coat…).</span>
                  </label>
                  <label className={ui.field}>
                    <span className={ui.label}>Scene</span>
                    <GrowField
                      value={page.scenePrompt}
                      onChange={(v) => setPage(page.index, { scenePrompt: v })}
                      placeholder="Where we are, what the main character is doing, who else is there."
                    />
                  </label>
                  <div className={styles.boxRow}>
                    <span className={ui.label}>Box</span>
                    {page.box ? (
                      <>
                        <span className={styles.boxNumbers}>
                          {Math.round(page.box.x)}%, {Math.round(page.box.y)}% · {Math.round(page.box.w)} × {Math.round(page.box.h)}%
                        </span>
                        <button className={cx(ui.btn, ui.ghost, ui.small)} onClick={() => setPage(page.index, { box: null })}>
                          Clear
                        </button>
                      </>
                    ) : (
                      <span className={styles.boxMissing}>Not drawn yet</span>
                    )}
                  </div>
                </div>
              )}

              {page.lines.length > 0 && (
                <div className={ui.section}>
                  <span className={ui.eyebrow}>Page text</span>
                  <p className={styles.pageText}>
                    {page.lines.map((l, i) => (
                      <Fragment key={i}>
                        {highlight(l.text, name)}
                        {i < page.lines.length - 1 ? ' ' : ''}
                      </Fragment>
                    ))}
                  </p>
                  <span className={ui.help}>
                    {name ? `"${name}" is replaced with the child's name.` : "Set the main character's name in Book settings to swap it for the child's."}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className={ui.panel}>
              <div className={ui.section}>
                <div className={styles.sectionHead}>
                  <span className={ui.eyebrow}>Main character</span>
                  <button className={cx(ui.btn, ui.secondary, ui.small)} onClick={() => withBusy('book', async () => void (await draftBook()))} disabled={!!busy}>
                    {busy === 'book' ? <span className={ui.spinner} /> : <SparkIcon />}
                    Fill in with AI
                  </button>
                </div>
                <span className={ui.help}>
                  The book&apos;s main character is the one replaced by the child. <strong>Fill in with AI</strong> reads the cover and the text to find their
                  name, look, clothing and the art style.
                </span>
                <div className={styles.pair}>
                  <label className={ui.field}>
                    <span className={ui.label}>Name in the text</span>
                    <input className={ui.input} value={book.settings.protagonistName} onChange={(e) => setSettings({ protagonistName: e.target.value })} placeholder="Ross" />
                  </label>
                  <div className={ui.field}>
                    <span className={ui.label}>Gender</span>
                    <div className={ui.segmented} role="group" aria-label="Main character gender">
                      {(['boy', 'girl'] as const).map((g) => (
                        <button key={g} className={ui.segment} aria-pressed={book.settings.protagonistGender === g} onClick={() => setSettings({ protagonistGender: g })}>
                          {g === 'boy' ? 'Boy' : 'Girl'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className={styles.changes}>
                  <span className={ui.label}>Changes to the child</span>
                  <span>Face, hair colour and style, skin tone and glasses, taken from the child&apos;s photo.</span>
                </div>
                <label className={ui.field}>
                  <span className={ui.label}>How to recognise them in the book</span>
                  <GrowField
                    value={book.settings.protagonistDescription}
                    onChange={(v) => setSettings({ protagonistDescription: v })}
                    placeholder="a 6-year-old boy with short brown hair"
                  />
                  <span className={ui.help}>Age, build and hair of the original character; leave clothing out.</span>
                </label>
                <label className={ui.field}>
                  <span className={ui.label}>Clothing (kept)</span>
                  <GrowField
                    value={book.settings.clothing ?? ''}
                    onChange={(v) => setSettings({ clothing: v })}
                    placeholder="yellow T-shirt with red trim, blue jeans, red sneakers"
                  />
                  <span className={ui.help}>Their usual outfit. The child wears exactly this; a page can override it.</span>
                </label>
                <span className={ui.help}>Changing he/she in the text for a child of the other gender is not built yet.</span>
              </div>

              <div className={ui.section}>
                <span className={ui.eyebrow}>Style</span>
                <label className={ui.field}>
                  <span className={ui.label}>Art style</span>
                  <GrowField
                    value={book.settings.artStyle}
                    onChange={(v) => setSettings({ artStyle: v })}
                    placeholder="soft watercolour with fine ink outlines and warm pastel washes"
                  />
                </label>
                <label className={ui.switchRow}>
                  <span className={styles.switchText}>
                    Keep everything outside the box
                    <span className={ui.help}>Only the main character&apos;s box is taken from the AI; the rest stays pixel-identical</span>
                  </span>
                  <input type="checkbox" className={ui.switch} checked={book.settings.keepOutsideBox} onChange={(e) => setSettings({ keepOutsideBox: e.target.checked })} />
                </label>
                <label className={ui.switchRow}>
                  <span className={styles.switchText}>
                    Edit a close-up around the box
                    <span className={ui.help}>The AI gets only the area around the main character, enlarged: sharper faces on small figures, pose kept better</span>
                  </span>
                  <input type="checkbox" className={ui.switch} checked={book.settings.closeUp !== false} onChange={(e) => setSettings({ closeUp: e.target.checked })} />
                </label>
                <label className={ui.switchRow}>
                  <span className={styles.switchText}>
                    Check each page automatically
                    <span className={ui.help}>AI compares each result with the original (pose, clothing, likeness) and redraws once if something is off</span>
                  </span>
                  <input type="checkbox" className={ui.switch} checked={book.settings.autoCheck !== false} onChange={(e) => setSettings({ autoCheck: e.target.checked })} />
                </label>
                <label className={ui.switchRow}>
                  <span className={styles.switchText}>
                    White outline on text
                    <span className={ui.help}>For text set over busy pictures</span>
                  </span>
                  <input type="checkbox" className={ui.switch} checked={book.settings.textHalo} onChange={(e) => setSettings({ textHalo: e.target.checked })} />
                </label>
              </div>

              <div className={ui.section}>
                <button className={cx(ui.btn, ui.danger, ui.small, styles.deleteBtn)} onClick={deleteBook} disabled={!!busy}>
                  <TrashIcon />
                  Delete book
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

/** Marks the hero's name in the page text. */
function highlight(text: string, name: string) {
  if (!name) return text;
  const parts = text.split(new RegExp(`(\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b)`, 'gi'));
  return parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}
