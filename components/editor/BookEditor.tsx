'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

import type { BookDraft, CastDraft } from '@/lib/ai/prompts';
import { api, cx, nameRegex } from '@/lib/client';
import { bookSpec, deleteBook as removeBook, saveBook } from '@/lib/local/store';
import {
  bookFile,
  castOn,
  draftImages,
  fileUrl,
  GENDERS,
  pageLabel,
  pageReadiness,
  pageState,
  presentOn,
  type Book,
  type BookCharacter,
  type BookSettings,
  type Box,
  type Page,
  type PageCast,
  type PageKind,
  type PageState,
} from '@/lib/types';

import { BookFonts, BookPage } from '../BookPage';
import { GrowField } from '../GrowField';
import { BackIcon, PlusIcon, SparkIcon, TrashIcon } from '../icons';
import { Toggle } from '../Toggle';
import ui from '../ui.module.css';
import { BoxEditor } from './BoxEditor';
import styles from './BookEditor.module.css';

type SaveState = 'saved' | 'saving' | 'error';
type Mode = 'book' | 'pages';

/** How each page state looks: the strip dot, the chip over the page, and its words. */
const STATE: Record<PageState, { dot: string; chip: string; label: string }> = {
  ready: { dot: ui.dotOk, chip: ui.sage, label: 'Ready' },
  needsBox: { dot: ui.dotWarn, chip: ui.peach, label: 'Someone still needs a box' },
  noCast: { dot: ui.dotInfo, chip: ui.sky, label: 'No one to replace: kept as is' },
  skip: { dot: '', chip: '', label: 'Skipped' },
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
  // A book without characters opens on its setup; a prepared one on its pages.
  const [mode, setMode] = useState<Mode>(initial.characters.length ? 'pages' : 'book');
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
  const readiness = pageReadiness(book);
  const state = STATE[pageState(book, page)];

  // Autosave 600 ms after the last change.
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(async () => {
      setSave('saving');
      try {
        await saveBook(book);
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
  }

  function removeCharacter(target: BookCharacter) {
    if (!window.confirm(`Remove ${target.label} from this book? Their boxes and notes on every page are deleted too.`)) return;
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

  /** "Prepare with AI" for the book (no `index`) or one page; a browser book goes with its art. */
  async function askDraft<T>(fields: { index?: number; characters?: BookCharacter[]; settings?: BookSettings }): Promise<T> {
    const form = new FormData();
    form.set('spec', JSON.stringify({ ...(await bookSpec(book, form, draftImages(book, fields.index))), ...fields }));
    return api<T>('/api/ai/draft', { method: 'POST', body: form });
  }

  /** Finds the book's characters and art style; merges them in without overwriting edits. */
  async function findCharacters(): Promise<{ characters: BookCharacter[]; settings: BookSettings }> {
    const draft = await askDraft<BookDraft>({});
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
    const draft = await askDraft<{ scenePrompt: string; cast: (Omit<CastDraft, 'box'> & { box: Box | null })[]; textBoxes: Box[]; keepObjects: string }>({ index: target.index, characters, settings });
    change((b) => ({
      ...b,
      pages: b.pages.map((p) => {
        if (p.index !== target.index) return p;
        const nextCast = { ...p.cast };
        for (const d of draft.cast) {
          const old = p.cast[d.id];
          const found = { present: d.present, hint: d.hint, pose: d.pose, clothing: d.clothing, expression: d.expression, box: d.box };
          nextCast[d.id] =
            onlyMissing && old
              ? { present: old.present, hint: old.hint || found.hint, pose: old.pose || found.pose, clothing: old.clothing || found.clothing, expression: old.expression || found.expression, box: old.box ?? found.box }
              : { ...found, box: old?.box ?? found.box };
        }
        const scenePrompt = onlyMissing ? p.scenePrompt || draft.scenePrompt : draft.scenePrompt || p.scenePrompt;
        const textBoxes = onlyMissing && p.textBoxes?.length ? p.textBoxes : draft.textBoxes;
        const keepObjects = onlyMissing && p.keepObjects?.trim() ? p.keepObjects : draft.keepObjects;
        return { ...p, scenePrompt, cast: nextCast, textBoxes, keepObjects };
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
          // textBoxes undefined = never checked for printed text (an empty list = checked, none).
          return !p.scenePrompt || unknown || p.textBoxes === undefined || p.keepObjects === undefined || present.some((c) => !p.cast[c.id].box || !p.cast[c.id].pose || !p.cast[c.id].clothing || p.cast[c.id].expression === undefined);
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
    if (!window.confirm(`Delete "${book.title}" and its pages? Books already made from it will stop opening.`)) return;
    await withBusy('delete', async () => {
      await removeBook(book);
      router.push('/studio');
    });
  }

  /** From Book setup to one page in Pages. */
  function openPage(index: number, characterId?: string) {
    setCurrent(index);
    if (characterId) setActive(characterId);
    setMode('pages');
  }

  const names = book.characters.map((c) => c.nameInText.trim()).filter(Boolean);
  const editable = page.kind !== 'skip' && !!character && !!cast?.present;
  const others = presentOn(book, page)
    .filter((c) => c.id !== character?.id && page.cast[c.id].box)
    .map((c) => ({ label: c.label, box: page.cast[c.id].box! }))
    // Printed text: kept from the original on every redraw.
    .concat((page.textBoxes ?? []).map((box) => ({ label: 'Text stays', box })));

  return (
    <main className={styles.layout}>
      <BookFonts book={book} />

      <header className={styles.head}>
        <Link href="/studio" className={cx(ui.btn, ui.ghost, ui.small, ui.back)}>
          <BackIcon />
          Books
        </Link>
        <input className={styles.title} value={book.title} onChange={(e) => change((b) => ({ ...b, title: e.target.value }))} aria-label="Book title" />
        <div className={cx(ui.segmented, styles.modes)} role="group" aria-label="What to edit">
          <button className={ui.segment} aria-pressed={mode === 'book'} onClick={() => setMode('book')}>
            Book setup
          </button>
          <button className={ui.segment} aria-pressed={mode === 'pages'} onClick={() => setMode('pages')}>
            Pages
          </button>
        </div>
        <span className={cx(ui.chip, readiness.total && readiness.ready === readiness.total ? ui.sage : ui.peach)}>
          {readiness.ready}/{readiness.total} pages ready
        </span>
        <span className={styles.save} aria-live="polite">
          {save === 'saving' ? 'Saving…' : save === 'error' ? 'Not saved — retrying on next change' : 'Saved'}
        </span>
        <button
          className={cx(ui.btn, ui.secondary)}
          onClick={prepareAll}
          disabled={!!busy}
          title="The AI reads the whole book: it finds the characters and the art style, then on every page marks where each character is and describes them and the scene. You check and correct it."
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

      {mode === 'book' ? (
        <div className={styles.setup}>
          {/* The whole book: who can be replaced, how it is drawn, how pages are made. Same on every page. */}
          <section className={cx(ui.panel, styles.setupCast)}>
            <div className={ui.section}>
              <div className={styles.sectionHead}>
                <h2 className={ui.panelTitle}>Characters</h2>
                <button className={cx(ui.btn, ui.secondary, ui.small)} onClick={() => withBusy('find', async () => void (await findCharacters()))} disabled={!!busy}>
                  {busy === 'find' ? <span className={ui.spinner} /> : <SparkIcon />}
                  Find with AI
                </button>
              </div>
              <span className={ui.help}>
                Everyone in the book a real person can play: the child, parents, friends. What you set here applies to every page.{' '}
                <strong>Find with AI</strong> reads the book and adds who it finds.
              </span>
              <CastPills book={book} activeId={character?.id} onPick={setActive} onAdd={addCharacter} />
            </div>

            {character ? (
              <div className={ui.section}>
                <label className={ui.field}>
                  <span className={ui.label}>Name in the book</span>
                  <input
                    className={ui.input}
                    value={character.label}
                    onChange={(e) =>
                      // A swapped name follows the name as it is typed.
                      setCharacter(character.id, character.nameInText.trim() ? { label: e.target.value, nameInText: e.target.value } : { label: e.target.value })
                    }
                    placeholder="Noah, Mama, the old fisherman"
                  />
                  <span className={ui.help}>The character as the book knows them. Who plays them is chosen in Make a book.</span>
                </label>
                <Toggle
                  label="Swap this name in the story text"
                  help={
                    character.nameInText.trim()
                      ? `“${character.nameInText.trim()}” in the text becomes your person’s name`
                      : 'Off for roles like Mama or Grandpa, which stay as written'
                  }
                  checked={!!character.nameInText.trim()}
                  onChange={(on) => setCharacter(character.id, { nameInText: on ? character.label : '' })}
                />
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
                  <span className={ui.label}>What changes</span>
                  <span>Your person&apos;s face, hair, skin tone and glasses replace this character&apos;s. Clothes and pose stay as drawn.</span>
                </div>
                <label className={ui.field}>
                  <span className={ui.label}>What they look like in the book</span>
                  <GrowField value={character.description} onChange={(v) => setCharacter(character.id, { description: v })} placeholder="a woman in her thirties with short red hair" />
                  <span className={ui.help}>Age, build and hair, so the AI can find them on each page. Leave clothes out.</span>
                </label>
                <label className={ui.field}>
                  <span className={ui.label}>What they usually wear</span>
                  <GrowField value={character.clothing} onChange={(v) => setCharacter(character.id, { clothing: v })} placeholder="turquoise blouse, lilac skirt" />
                  <span className={ui.help}>Only a hint: on every page the clothes are kept exactly as drawn.</span>
                </label>
                <button className={cx(ui.btn, ui.ghost, ui.small, styles.removeBtn)} onClick={() => removeCharacter(character)}>
                  <TrashIcon />
                  Remove {character.label}
                </button>
              </div>
            ) : (
              <div className={styles.emptyCast}>
                <p>No characters yet.</p>
                <span className={ui.help}>Use Find with AI above, or add one by hand.</span>
              </div>
            )}
          </section>

          <div className={styles.setupSide}>
            {character && <CharacterInBook book={book} character={character} onOpen={openPage} />}

            <section className={ui.panel}>
              <div className={ui.section}>
                <h2 className={ui.panelTitle}>Art style</h2>
                <div className={styles.styleStrip} role="list" aria-label="The book's pages">
                  {book.pages
                    .filter((p) => p.kind !== 'skip')
                    .map((p) => (
                      <button key={p.index} role="listitem" className={styles.styleThumb} onClick={() => openPage(p.index)} title={`Open ${pageLabel(book, p)}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fileUrl(bookFile(book, p.thumb))} alt={pageLabel(book, p)} style={{ aspectRatio: `${book.pageWidth} / ${book.pageHeight}` }} />
                      </button>
                    ))}
                </div>
                <label className={ui.field}>
                  <span className={ui.label}>How the book is drawn</span>
                  <GrowField value={book.settings.artStyle} onChange={(v) => setSettings({ artStyle: v })} placeholder="soft watercolour with fine ink outlines and warm pastel washes" />
                  <span className={ui.help}>Sent with every picture, so the people we draw match the book. Describe the lines, colours and texture.</span>
                </label>
              </div>
            </section>

            <section className={ui.panel}>
              <div className={ui.section}>
                <h2 className={ui.panelTitle}>How pages are redrawn</h2>
                <Toggle
                  label="Keep the rest of the page untouched"
                  help="Only the area around each character changes; everything else stays exactly as in the original"
                  checked={book.settings.keepOutsideBox}
                  onChange={(v) => setSettings({ keepOutsideBox: v })}
                />
                <Toggle
                  label="Zoom in on the characters"
                  help="The AI works on an enlarged area around them: sharper faces, poses kept better"
                  checked={book.settings.closeUp !== false}
                  onChange={(v) => setSettings({ closeUp: v })}
                />
                <Toggle label="White outline around text" help="Easier to read over busy pictures" checked={book.settings.textHalo} onChange={(v) => setSettings({ textHalo: v })} />
              </div>
            </section>

            <div className={styles.setupFoot}>
              <button className={cx(ui.btn, ui.primary)} onClick={() => setMode('pages')}>
                Go to the pages
              </button>
              <button className={cx(ui.btn, ui.danger, ui.small)} onClick={deleteBook} disabled={!!busy}>
                <TrashIcon />
                Delete book
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.columns}>
          <nav className={styles.strip} aria-label="Pages">
            {book.pages.map((p) => {
              const thumbState = pageState(book, p);
              return (
                <button
                  key={p.index}
                  className={cx(styles.thumb, p.index === current && styles.thumbOn, thumbState === 'skip' && styles.thumbSkip)}
                  onClick={() => setCurrent(p.index)}
                  aria-current={p.index === current}
                  title={STATE[thumbState].label}
                >
                  <span className={styles.thumbImg} style={{ aspectRatio: `${book.pageWidth} / ${book.pageHeight}` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl(bookFile(book, p.thumb))} alt="" />
                    <span className={cx(ui.dot, styles.thumbDot, STATE[thumbState].dot)} />
                  </span>
                  <span className={styles.thumbLabel}>{p.kind === 'skip' ? `Skipped (PDF page ${p.index})` : pageLabel(book, p)}</span>
                </button>
              );
            })}
          </nav>

          <section className={styles.canvas}>
            <div className={styles.canvasBar}>
              <span className={cx(ui.chip, state.chip)}>{state.label}</span>
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
                  editable ? <BoxEditor box={cast!.box} label={character!.label} others={others} onChange={(box) => setCast(page.index, character!.id, { box })} /> : null
                }
              />
            </div>
          </section>

          {/* Only this page: its type, who is on it and how, then the page itself. The book-wide setup is in Book setup. */}
          <aside className={styles.inspector}>
            <div className={ui.panel}>
              <div className={ui.section}>
                <span className={ui.eyebrow}>{page.kind === 'skip' ? `Skipped (PDF page ${page.index})` : pageLabel(book, page)}</span>
                <div className={ui.field}>
                  <span className={ui.label}>Page type</span>
                  <div className={ui.segmented} role="group" aria-label="Page type">
                    {(['cover', 'page', 'skip'] as PageKind[]).map((k) => (
                      <button key={k} className={ui.segment} aria-pressed={page.kind === k} onClick={() => setPage(page.index, { kind: k })}>
                        {k === 'cover' ? 'Cover' : k === 'page' ? 'Story page' : 'Skip'}
                      </button>
                    ))}
                  </div>
                  {page.kind === 'skip' && <span className={ui.help}>Skipped pages (ads, promo, back cover) are left out of the book.</span>}
                </div>
              </div>

              {page.kind !== 'skip' && (
                <div className={ui.section}>
                  <div className={styles.sectionHead}>
                    <span className={ui.eyebrow}>Characters</span>
                    <button
                      className={cx(ui.btn, ui.secondary, ui.small)}
                      onClick={() => withBusy(`page${page.index}`, () => draftPage(page))}
                      disabled={!!busy || !book.characters.length}
                      title="Finds every character on this page and draws their boxes"
                    >
                      {busy === `page${page.index}` ? <span className={ui.spinner} /> : <SparkIcon />}
                      Find on this page
                    </button>
                  </div>
                  {character ? (
                    <>
                      <CastPills book={book} page={page} activeId={character.id} onPick={setActive} />
                      <span className={ui.help}>Describe {character.label} as drawn here. All of it is kept when the page is redrawn; only the face, hair and skin change.</span>
                      <Toggle label={`${character.label} is on this page`} checked={!!cast?.present} onChange={(present) => setCast(page.index, character.id, { present })} />
                      {cast?.present && (
                        <>
                          <label className={ui.field}>
                            <span className={ui.label}>Which one is {character.label}</span>
                            <GrowField rows={1} value={cast.hint} onChange={(v) => setCast(page.index, character.id, { hint: v })} placeholder="the woman in the turquoise blouse, right" />
                          </label>
                          <label className={ui.field}>
                            <span className={ui.label}>Pose and direction</span>
                            <GrowField value={cast.pose} onChange={(v) => setCast(page.index, character.id, { pose: v })} placeholder="three-quarter view facing left, smiling down at the girl" />
                          </label>
                          <label className={ui.field}>
                            <span className={ui.label}>Facial expression</span>
                            <GrowField
                              rows={1}
                              value={cast.expression ?? ''}
                              onChange={(v) => setCast(page.index, character.id, { expression: v })}
                              placeholder="focused, eyes down on the toy, mouth closed"
                            />
                          </label>
                          <label className={ui.field}>
                            <span className={ui.label}>Clothes on this page</span>
                            <GrowField
                              rows={1}
                              value={cast.clothing}
                              onChange={(v) => setCast(page.index, character.id, { clothing: v })}
                              placeholder="What they wear in this picture"
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
                              <span className={styles.boxMissing}>Not drawn yet: drag on the picture</span>
                            )}
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div className={styles.emptyCast}>
                      <p>No characters yet.</p>
                      <button className={cx(ui.btn, ui.secondary, ui.small, styles.emptyAction)} onClick={() => setMode('book')}>
                        Set them up in Book setup
                      </button>
                    </div>
                  )}
                </div>
              )}

              {page.kind !== 'skip' && (
                <div className={ui.section}>
                  <span className={ui.eyebrow}>The page</span>
                  <label className={ui.field}>
                    <span className={ui.label}>What is happening</span>
                    <GrowField value={page.scenePrompt} onChange={(v) => setPage(page.index, { scenePrompt: v })} placeholder="Where we are, who is there and what they are doing." />
                  </label>
                  <label className={ui.field}>
                    <span className={ui.label}>Things that must not move</span>
                    <GrowField
                      value={page.keepObjects ?? ''}
                      onChange={(v) => setPage(page.index, { keepObjects: v })}
                      placeholder="e.g. the toy castle under the boy's hands"
                    />
                    <span className={ui.help}>Objects the characters touch or overlap. Every redraw leaves them exactly as they are.</span>
                  </label>
                  {page.lines.length > 0 && (
                    <div className={ui.field}>
                      <span className={ui.label}>Text on the page</span>
                      <p className={styles.pageText}>
                        {page.lines.map((l, i) => (
                          <Fragment key={i}>
                            {highlight(l.text, names)}
                            {i < page.lines.length - 1 ? ' ' : ''}
                          </Fragment>
                        ))}
                      </p>
                      <span className={ui.help}>
                        {names.length ? 'Highlighted names are swapped for your people’s names.' : 'Add each character’s name in the original book in Book setup, and it’s swapped in the text.'}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

/** Marks the characters' names in the page text (the same matching as the name swap). */
function highlight(text: string, names: string[]) {
  if (!names.length) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(nameRegex(names))) {
    parts.push(text.slice(last, m.index), <mark key={m.index}>{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

/**
 * The book's characters as pills. With a `page`: a dot on those who are on it (green = boxed,
 * peach = no box yet). With `onAdd`: an Add pill at the end.
 */
function CastPills({ book, page, activeId, onPick, onAdd }: { book: Book; page?: Page; activeId?: string; onPick: (id: string) => void; onAdd?: () => void }) {
  return (
    <div className={styles.castPills} role="group" aria-label="Characters">
      {book.characters.map((c) => (
        <button key={c.id} className={cx(ui.btn, ui.small, c.id === activeId ? ui.primary : ui.secondary)} onClick={() => onPick(c.id)} aria-pressed={c.id === activeId}>
          {c.label}
          {page?.cast[c.id]?.present && <span className={cx(ui.dot, page.cast[c.id].box ? ui.dotOk : ui.dotWarn)} title="On this page" />}
        </button>
      ))}
      {onAdd && (
        <button className={cx(ui.btn, ui.small, ui.secondary)} onClick={onAdd}>
          <PlusIcon />
          Add
        </button>
      )}
    </div>
  );
}

/**
 * Book setup's view of one character across the book: their box cut out of every page they are
 * on, so the description and usual clothing are written while looking at them. A cut-out opens
 * that page; pages where they have no box yet are listed underneath.
 */
function CharacterInBook({ book, character, onOpen }: { book: Book; character: BookCharacter; onOpen: (index: number, characterId?: string) => void }) {
  const on = book.pages.filter((p) => p.kind !== 'skip' && p.cast[character.id]?.present);
  const boxed = on.filter((p) => p.cast[character.id].box);
  const unboxed = on.filter((p) => !p.cast[character.id].box);
  return (
    <section className={ui.panel}>
      <div className={ui.section}>
        <div className={styles.sectionHead}>
          <h2 className={ui.panelTitle}>{character.label} in the book</h2>
          <span className={ui.muted}>{on.length ? `On ${on.length} of ${book.pages.filter((p) => p.kind !== 'skip').length} pages` : 'Not on any page yet'}</span>
        </div>
        {boxed.length > 0 && (
          <div className={styles.crops}>
            {boxed.map((p) => {
              const b = p.cast[character.id].box!;
              return (
                <button key={p.index} className={styles.crop} onClick={() => onOpen(p.index, character.id)} title={`Open ${pageLabel(book, p)}`}>
                  <span className={styles.cropFrame} style={{ aspectRatio: `${b.w * book.pageWidth} / ${b.h * book.pageHeight}` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={fileUrl(bookFile(book, p.image))}
                      alt=""
                      style={{ width: `${10000 / b.w}%`, left: `${(-100 * b.x) / b.w}%`, top: `${(-100 * b.y) / b.h}%` }}
                    />
                  </span>
                  <span className={styles.cropLabel}>{pageLabel(book, p)}</span>
                </button>
              );
            })}
          </div>
        )}
        {unboxed.length > 0 && (
          <span className={ui.help}>
            No box yet on {unboxed.map((p) => pageLabel(book, p)).join(', ')}: open the page to draw it.
          </span>
        )}
        {!on.length && <span className={ui.help}>Prepare all pages with AI finds them, or mark them on each page in Pages.</span>}
      </div>
    </section>
  );
}
