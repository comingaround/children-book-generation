'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';

import type { BookDraft, CastDraft } from '@/lib/ai/prompts';
import { api, cx } from '@/lib/client';
import {
  castOn,
  fileUrl,
  GENDERS,
  pageState,
  presentOn,
  type Book,
  type BookCharacter,
  type BookSettings,
  type Box,
  type Page,
  type PageCast,
  type PageKind,
} from '@/lib/types';

import { BookFonts, BookPage } from '../BookPage';
import { GrowField } from '../GrowField';
import { BackIcon, PlusIcon, SparkIcon, TrashIcon } from '../icons';
import ui from '../ui.module.css';
import { BoxEditor } from './BoxEditor';
import styles from './BookEditor.module.css';

type SaveState = 'saved' | 'saving' | 'error';
type Tab = 'characters' | 'scene';

const DOT: Record<ReturnType<typeof pageState>, string> = {
  ready: ui.dotOk,
  needsBox: ui.dotWarn,
  noHero: ui.dotInfo,
  skip: '',
};

const STATE_LABEL: Record<ReturnType<typeof pageState>, string> = {
  ready: 'Ready',
  needsBox: 'A character needs a box',
  noHero: 'No characters, kept as is',
  skip: 'Skipped',
};

const blankCharacter = (id: string): BookCharacter => ({ id, label: 'New character', nameInText: '', gender: 'girl', description: '', clothing: '' });

const nextId = (characters: BookCharacter[]) => `c${Math.max(0, ...characters.map((c) => Number(c.id.slice(1)) || 0)) + 1}`;

const same = (a: string, b: string) => !!a.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Merges found characters into the cast: a match (same name or label) gets its empty fields
 * filled, anyone new is added. Nothing typed by hand is overwritten.
 */
function mergeCharacters(current: BookCharacter[], found: BookDraft['characters']): BookCharacter[] {
  const result = current.map((c) => ({ ...c }));
  for (const f of found) {
    const match = result.find((c) => same(c.nameInText, f.nameInText) || same(c.label, f.label) || same(c.label, f.nameInText));
    if (match) {
      for (const key of ['label', 'nameInText', 'description', 'clothing'] as const) if (!match[key].trim()) match[key] = f[key];
    } else {
      result.push({ ...f, id: nextId(result) });
    }
  }
  return result;
}

export function BookEditor({ initial }: { initial: Book }) {
  const router = useRouter();
  const [book, setBook] = useState(initial);
  const [current, setCurrent] = useState(initial.pages.find((p) => p.kind !== 'skip')?.index ?? 1);
  const [tab, setTab] = useState<Tab>('characters');
  const [active, setActive] = useState(initial.characters[0]?.id ?? '');
  const [showText, setShowText] = useState(true);
  const [save, setSave] = useState<SaveState>('saved');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);

  const page = book.pages.find((p) => p.index === current) ?? book.pages[0];
  const character = book.characters.find((c) => c.id === active) ?? book.characters[0] ?? null;
  const cast = character ? castOn(page, character.id) : null;
  const castPages = book.pages.filter((p) => ['ready', 'needsBox'].includes(pageState(book, p)));
  const ready = castPages.filter((p) => pageState(book, p) === 'ready').length;

  // Autosave 600 ms after the last change.
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(async () => {
      setSave('saving');
      try {
        await api(`/api/books/${book.id}`, {
          method: 'PUT',
          json: { title: book.title, characters: book.characters, settings: book.settings, pages: book.pages },
        });
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
  const setCast = (index: number, id: string, patch: Partial<PageCast>) =>
    change((b) => ({
      ...b,
      pages: b.pages.map((p) => (p.index === index ? { ...p, cast: { ...p.cast, [id]: { ...castOn(p, id), ...patch } } } : p)),
    }));
  const setCharacter = (id: string, patch: Partial<BookCharacter>) =>
    change((b) => ({ ...b, characters: b.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const setSettings = (patch: Partial<BookSettings>) => change((b) => ({ ...b, settings: { ...b.settings, ...patch } }));

  function addCharacter() {
    const id = nextId(book.characters);
    change((b) => ({ ...b, characters: [...b.characters, blankCharacter(id)] }));
    setActive(id);
    setTab('characters');
  }

  function removeCharacter(target: BookCharacter) {
    if (!window.confirm(`Remove ${target.label} from this book? Their boxes and notes on every page go too.`)) return;
    change((b) => ({
      ...b,
      characters: b.characters.filter((c) => c.id !== target.id),
      pages: b.pages.map((p) => {
        const rest = { ...p.cast };
        delete rest[target.id];
        return { ...p, cast: rest };
      }),
    }));
    setActive(book.characters.find((c) => c.id !== target.id)?.id ?? '');
  }

  /** Finds the book's characters and art style; merges them in without overwriting edits. */
  async function findCharacters(): Promise<{ characters: BookCharacter[]; settings: BookSettings }> {
    const draft = await api<BookDraft>(`/api/books/${book.id}/draft`, { method: 'POST', json: {} });
    const characters = mergeCharacters(book.characters, draft.characters);
    const settings = book.settings.artStyle.trim() ? book.settings : { ...book.settings, artStyle: draft.artStyle };
    change((b) => ({ ...b, characters, settings }));
    if (!active && characters[0]) setActive(characters[0].id);
    return { characters, settings };
  }

  /**
   * Every character on one page, plus the scene. Never replaces a box drawn by hand.
   * `onlyMissing` (Prepare all) fills only characters and fields not set yet, so edits survive.
   */
  async function draftPage(target: Page, characters = book.characters, settings = book.settings, onlyMissing = false) {
    const draft = await api<{ scenePrompt: string; cast: (Omit<CastDraft, 'box'> & { box: Box | null })[] }>(`/api/books/${book.id}/draft`, {
      method: 'POST',
      json: { index: target.index, characters, settings },
    });
    change((b) => ({
      ...b,
      pages: b.pages.map((p) => {
        if (p.index !== target.index) return p;
        const nextCast = { ...p.cast };
        for (const d of draft.cast) {
          const old = p.cast[d.id];
          const found = { present: d.present, hint: d.hint, pose: d.pose, clothing: d.clothingDiffers ? d.clothing : '', box: d.box };
          nextCast[d.id] =
            onlyMissing && old
              ? { present: old.present, hint: old.hint || found.hint, pose: old.pose || found.pose, clothing: old.clothing, box: old.box ?? found.box }
              : { ...found, box: old?.box ?? found.box };
        }
        const scenePrompt = onlyMissing ? p.scenePrompt || draft.scenePrompt : draft.scenePrompt || p.scenePrompt;
        return { ...p, scenePrompt, cast: nextCast };
      }),
    }));
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

  /** Characters first (page drafts need them), then every page that isn't prepared yet. */
  const prepareAll = () =>
    withBusy('all', async () => {
      try {
        let characters = book.characters;
        let settings = book.settings;
        if (!characters.length || !settings.artStyle.trim()) {
          setProgress('Finding the characters…');
          ({ characters, settings } = await findCharacters());
        }
        const todo = book.pages.filter((p) => {
          if (p.kind === 'skip') return false;
          const present = characters.filter((c) => p.cast[c.id]?.present);
          const unknown = characters.some((c) => !p.cast[c.id]);
          return !p.scenePrompt || unknown || present.some((c) => !p.cast[c.id].box || !p.cast[c.id].pose);
        });
        for (const [i, p] of todo.entries()) {
          setProgress(`Page ${i + 1} of ${todo.length}…`);
          setCurrent(p.index);
          await draftPage(p, characters, settings, true);
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

  const names = book.characters.map((c) => c.nameInText.trim()).filter(Boolean);
  const editable = page.kind !== 'skip' && !!character && !!cast?.present;
  const others = presentOn(book, page)
    .filter((c) => c.id !== character?.id && page.cast[c.id].box)
    .map((c) => ({ label: c.label, box: page.cast[c.id].box! }));

  return (
    <main className={styles.layout}>
      <BookFonts book={book} />

      <header className={styles.head}>
        <Link href="/" className={cx(ui.btn, ui.ghost, ui.small)}>
          <BackIcon />
          Library
        </Link>
        <input className={styles.title} value={book.title} onChange={(e) => change((b) => ({ ...b, title: e.target.value }))} aria-label="Book title" />
        <span className={cx(ui.chip, castPages.length && ready === castPages.length ? ui.sage : ui.peach)}>
          {ready}/{castPages.length} pages ready
        </span>
        <span className={styles.save} aria-live="polite">
          {save === 'saving' ? 'Saving…' : save === 'error' ? 'Not saved — retrying on next change' : 'Saved'}
        </span>
        <button
          className={cx(ui.btn, ui.secondary)}
          onClick={prepareAll}
          disabled={!!busy}
          title="AI reads the whole book: finds the characters and the art style, then on every page finds each character, draws their box and writes their pose and the scene. You check and correct it."
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
            const state = pageState(book, p);
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
            <span className={cx(ui.chip, { ready: ui.sage, needsBox: ui.peach, noHero: ui.sky, skip: '' }[pageState(book, page)])}>
              {STATE_LABEL[pageState(book, page)]}
            </span>
            <span className={ui.muted}>{editable ? `Drag on the picture to draw a box around ${character!.label}` : ''}</span>
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
                editable ? (
                  <BoxEditor
                    box={cast!.box}
                    label={character!.label}
                    others={others}
                    onChange={(box) => setCast(page.index, character!.id, { box })}
                  />
                ) : null
              }
            />
          </div>
        </section>

        <aside className={styles.inspector}>
          <div className={ui.segmented} role="group" aria-label="Settings">
            <button className={ui.segment} aria-pressed={tab === 'characters'} onClick={() => setTab('characters')}>
              Characters
            </button>
            <button className={ui.segment} aria-pressed={tab === 'scene'} onClick={() => setTab('scene')}>
              Scene &amp; style
            </button>
          </div>

          {tab === 'characters' ? (
            <div className={ui.panel}>
              {/* The book's cast */}
              <div className={ui.section}>
                <div className={styles.sectionHead}>
                  <span className={ui.eyebrow}>The book&apos;s characters</span>
                  <button className={cx(ui.btn, ui.secondary, ui.small)} onClick={() => withBusy('find', async () => void (await findCharacters()))} disabled={!!busy}>
                    {busy === 'find' ? <span className={ui.spinner} /> : <SparkIcon />}
                    Find with AI
                  </button>
                </div>
                <span className={ui.help}>
                  Everyone who can be replaced by a real person: the main character, parents, friends. Each gets the person&apos;s face, hair and skin tone and keeps their
                  clothing and pose. <strong>Find with AI</strong> reads the book and adds who it finds.
                </span>
                <div className={styles.castPills} role="group" aria-label="Characters">
                  {book.characters.map((c) => (
                    <button key={c.id} className={cx(styles.castPill, c.id === character?.id && styles.castPillOn)} onClick={() => setActive(c.id)} aria-pressed={c.id === character?.id}>
                      {c.label}
                      {page.cast[c.id]?.present && <span className={cx(ui.dot, page.cast[c.id].box ? ui.dotOk : ui.dotWarn)} title="On this page" />}
                    </button>
                  ))}
                  <button className={styles.castPill} onClick={addCharacter}>
                    <PlusIcon />
                    Add
                  </button>
                </div>
              </div>

              {character ? (
                <>
                  <div className={ui.section}>
                    <div className={styles.pair}>
                      <label className={ui.field}>
                        <span className={ui.label}>Called in the editor</span>
                        <input className={ui.input} value={character.label} onChange={(e) => setCharacter(character.id, { label: e.target.value })} placeholder="Mommy" />
                      </label>
                      <label className={ui.field}>
                        <span className={ui.label}>Name in the text</span>
                        <input
                          className={ui.input}
                          value={character.nameInText}
                          onChange={(e) => setCharacter(character.id, { nameInText: e.target.value })}
                          placeholder="none"
                        />
                      </label>
                    </div>
                    <div className={ui.field}>
                      <span className={ui.label}>Gender</span>
                      <div className={ui.segmented} role="group" aria-label={`${character.label}'s gender`}>
                        {GENDERS.map((g) => (
                          <button key={g.value} className={ui.segment} aria-pressed={character.gender === g.value} onClick={() => setCharacter(character.id, { gender: g.value })}>
                            {g.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className={styles.changes}>
                      <span className={ui.label}>Changes to the person</span>
                      <span>Face, hair colour and style, skin tone, facial hair and glasses, taken from their photo.</span>
                    </div>
                    <label className={ui.field}>
                      <span className={ui.label}>How to recognise them in the book</span>
                      <GrowField
                        value={character.description}
                        onChange={(v) => setCharacter(character.id, { description: v })}
                        placeholder="a woman in her thirties with short red hair"
                      />
                      <span className={ui.help}>Age, build and hair of the original character; leave clothing out.</span>
                    </label>
                    <label className={ui.field}>
                      <span className={ui.label}>Clothing (kept)</span>
                      <GrowField value={character.clothing} onChange={(v) => setCharacter(character.id, { clothing: v })} placeholder="turquoise blouse, lilac skirt" />
                      <span className={ui.help}>Their usual outfit. The person wears exactly this; a page can override it.</span>
                    </label>
                    <button className={cx(ui.btn, ui.ghost, ui.small, styles.removeBtn)} onClick={() => removeCharacter(character)}>
                      <TrashIcon />
                      Remove {character.label}
                    </button>
                  </div>

                  {page.kind !== 'skip' && (
                    <div className={ui.section}>
                      <div className={styles.sectionHead}>
                        <span className={ui.eyebrow}>
                          {character.label} on {page.kind === 'cover' ? 'the cover' : `page ${page.index}`}
                        </span>
                        <button className={cx(ui.btn, ui.secondary, ui.small)} onClick={() => withBusy(`page${page.index}`, () => draftPage(page))} disabled={!!busy}>
                          {busy === `page${page.index}` ? <span className={ui.spinner} /> : <SparkIcon />}
                          Find on this page
                        </button>
                      </div>
                      <label className={ui.switchRow}>
                        <span className={styles.switchText}>
                          {character.label} is on this page
                          <span className={ui.help}>Find on this page checks every character at once and draws their boxes</span>
                        </span>
                        <input type="checkbox" className={ui.switch} checked={!!cast?.present} onChange={(e) => setCast(page.index, character.id, { present: e.target.checked })} />
                      </label>
                      {cast?.present && (
                        <>
                          <label className={ui.field}>
                            <span className={ui.label}>Which one is {character.label}</span>
                            <GrowField rows={1} value={cast.hint} onChange={(v) => setCast(page.index, character.id, { hint: v })} placeholder="the woman in the turquoise blouse, right" />
                          </label>
                          <label className={ui.field}>
                            <span className={ui.label}>Pose and direction (kept)</span>
                            <GrowField value={cast.pose} onChange={(v) => setCast(page.index, character.id, { pose: v })} placeholder="three-quarter view facing left, smiling down at the girl" />
                          </label>
                          <label className={ui.field}>
                            <span className={ui.label}>Clothing on this page (kept)</span>
                            <GrowField
                              rows={1}
                              value={cast.clothing}
                              onChange={(v) => setCast(page.index, character.id, { clothing: v })}
                              placeholder={character.clothing ? `Usual: ${character.clothing}` : 'Their usual outfit'}
                            />
                          </label>
                          <div className={styles.boxRow}>
                            <span className={ui.label}>Box</span>
                            {cast.box ? (
                              <>
                                <span className={styles.boxNumbers}>
                                  {Math.round(cast.box.x)}%, {Math.round(cast.box.y)}% · {Math.round(cast.box.w)} × {Math.round(cast.box.h)}%
                                </span>
                                <button className={cx(ui.btn, ui.ghost, ui.small)} onClick={() => setCast(page.index, character.id, { box: null })}>
                                  Clear
                                </button>
                              </>
                            ) : (
                              <span className={styles.boxMissing}>Not drawn yet</span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className={styles.emptyCast}>
                  <p>No characters yet.</p>
                  <span className={ui.help}>Use Find with AI above, or add one by hand.</span>
                </div>
              )}
            </div>
          ) : (
            <div className={ui.panel}>
              <div className={ui.section}>
                <span className={ui.eyebrow}>{page.kind === 'cover' ? 'Cover' : `Page ${page.index}`}</span>
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
                  <label className={ui.field}>
                    <span className={ui.label}>Scene</span>
                    <GrowField
                      value={page.scenePrompt}
                      onChange={(v) => setPage(page.index, { scenePrompt: v })}
                      placeholder="Where we are, who is there and what they are doing."
                    />
                  </label>
                )}
                {page.lines.length > 0 && (
                  <div className={ui.field}>
                    <span className={ui.label}>Page text</span>
                    <p className={styles.pageText}>
                      {page.lines.map((l, i) => (
                        <Fragment key={i}>
                          {highlight(l.text, names)}
                          {i < page.lines.length - 1 ? ' ' : ''}
                        </Fragment>
                      ))}
                    </p>
                    <span className={ui.help}>
                      {names.length ? 'Marked names are replaced with the people’s names.' : 'Set “Name in the text” on a character to swap it for the person’s name.'}
                    </span>
                  </div>
                )}
              </div>

              <div className={ui.section}>
                <span className={ui.eyebrow}>Art style</span>
                <label className={ui.field}>
                  <span className={ui.label}>How the book is drawn</span>
                  <GrowField value={book.settings.artStyle} onChange={(v) => setSettings({ artStyle: v })} placeholder="soft watercolour with fine ink outlines and warm pastel washes" />
                  <span className={ui.help}>
                    Sent with every drawing so redrawn people match the book. Be specific about line weight, colouring and texture.
                  </span>
                </label>
              </div>

              <div className={ui.section}>
                <span className={ui.eyebrow}>Generation</span>
                <Toggle
                  label="Keep everything outside the box"
                  help="Only each character's box is taken from the AI; the rest stays pixel-identical"
                  checked={book.settings.keepOutsideBox}
                  onChange={(v) => setSettings({ keepOutsideBox: v })}
                />
                <Toggle
                  label="Edit a close-up around the box"
                  help="The AI gets only the area around each character, enlarged: sharper faces on small figures, pose kept better"
                  checked={book.settings.closeUp !== false}
                  onChange={(v) => setSettings({ closeUp: v })}
                />
                <Toggle label="White outline on text" help="For text set over busy pictures" checked={book.settings.textHalo} onChange={(v) => setSettings({ textHalo: v })} />
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

function Toggle({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={ui.switchRow}>
      <span className={styles.switchText}>
        {label}
        <span className={ui.help}>{help}</span>
      </span>
      <input type="checkbox" className={ui.switch} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Marks the characters' names in the page text. */
function highlight(text: string, names: string[]) {
  if (!names.length) return text;
  const pattern = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const parts = text.split(new RegExp(`(\\b(?:${pattern})\\b)`, 'gi'));
  return parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}
