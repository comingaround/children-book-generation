'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, cx, money } from '@/lib/client';
import { drawingKey, GENDERS, testPages, type Book, type Person, type Run } from '@/lib/types';

import ui from '../ui.module.css';
import { People } from './People';
import styles from './RunPanel.module.css';

interface Props {
  books: Book[];
  selected: string | null;
  onSelect: (id: string) => void;
  initialPeople: Person[];
  price: number;
}

const genderLabel = (g: string) => GENDERS.find((x) => x.value === g)?.label.toLowerCase() ?? g;

/** Book → who plays which character → pages → Generate. The people list lives below it. */
export function RunPanel({ books, selected, onSelect, initialPeople, price }: Props) {
  const router = useRouter();
  const [people, setPeople] = useState(initialPeople);
  /** Person id by character id, per book, so switching books keeps each book's choices. */
  const [cast, setCast] = useState<Record<string, Record<string, string>>>({});
  const [mode, setMode] = useState<'test' | 'all'>('test');
  const [reuse, setReuse] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const book = books.find((b) => b.id === selected) ?? null;
  const chosen = (book && cast[book.id]) || {};
  const assignments = book
    ? book.characters.filter((c) => chosen[c.id] && people.some((p) => p.id === chosen[c.id] && p.photo)).map((c) => ({ characterId: c.id, personId: chosen[c.id] }))
    : [];

  const assign = (characterId: string, personId: string) => book && setCast((all) => ({ ...all, [book.id]: { ...all[book.id], [characterId]: personId } }));

  // Cost: one drawing per person without a saved one, plus one image per assigned character per page.
  const pageIndexes = book ? testPages(book, mode === 'all' ? 'all' : 3, assignments.map((a) => a.characterId)) : [];
  const saved = (a: { characterId: string; personId: string }) => !!people.find((p) => p.id === a.personId)?.drawings[drawingKey(book!.id, a.characterId)];
  const drawings = assignments.filter((a) => !(reuse && saved(a))).length;
  const pageImages = book
    ? pageIndexes.reduce((n, i) => n + assignments.filter((a) => book.pages.find((p) => p.index === i)?.cast[a.characterId]?.present).length, 0)
    : 0;
  const images = drawings + pageImages;

  async function generate() {
    if (!book) return;
    setBusy(true);
    setError(null);
    try {
      const run = await api<Run>('/api/runs', { method: 'POST', json: { bookId: book.id, assignments, pages: mode, reuseDrawings: reuse } });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className={styles.stack}>
      <div className={ui.panel}>
        <div className={ui.section}>
          <h2 className={ui.panelTitle}>New run</h2>
          <label className={ui.field}>
            <span className={ui.label}>Book</span>
            <select className={cx(ui.input, styles.select)} value={selected ?? ''} onChange={(e) => onSelect(e.target.value)}>
              {!selected && <option value="">Choose a book</option>}
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        {book && (
          <div className={ui.section}>
            <span className={ui.eyebrow}>Who plays whom</span>
            {book.characters.length === 0 ? (
              <p className={cx(ui.notice, ui.noticeInfo)}>
                <span className={ui.dot} />
                This book has no characters yet. Open it and press Prepare all pages with AI.
              </p>
            ) : (
              <ul className={styles.castList}>
                {book.characters.map((c) => {
                  const takenBy = new Set(Object.entries(chosen).filter(([id, p]) => id !== c.id && p).map(([, p]) => p));
                  return (
                    <li key={c.id} className={styles.castRow}>
                      <span className={styles.castName}>
                        <strong>{c.label}</strong>
                        <span className={ui.muted}>{genderLabel(c.gender)}</span>
                      </span>
                      <select
                        className={cx(ui.input, styles.select, styles.castSelect)}
                        value={chosen[c.id] ?? ''}
                        onChange={(e) => assign(c.id, e.target.value)}
                        aria-label={`Who plays ${c.label}`}
                      >
                        <option value="">Keep as in the book</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id} disabled={takenBy.has(p.id) || !p.photo}>
                            {p.name}
                            {!p.photo ? ' (no photo)' : ''}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>
            )}
            {people.length === 0 && book.characters.length > 0 && <span className={ui.help}>Add people below first.</span>}
          </div>
        )}

        {book && assignments.length > 0 && (
          <div className={ui.section}>
            <span className={ui.eyebrow}>Pages</span>
            <div className={ui.segmented} role="group" aria-label="Pages to generate">
              <button className={ui.segment} aria-pressed={mode === 'test'} onClick={() => setMode('test')}>
                Cover + 3 pages
              </button>
              <button className={ui.segment} aria-pressed={mode === 'all'} onClick={() => setMode('all')}>
                All pages
              </button>
            </div>
            {assignments.some(saved) && (
              <label className={ui.switchRow}>
                <span className={styles.switchText}>
                  Reuse approved drawings
                  <span className={ui.help}>Skips step 1 for anyone already drawn as this character</span>
                </span>
                <input type="checkbox" className={ui.switch} checked={reuse} onChange={(e) => setReuse(e.target.checked)} />
              </label>
            )}
            <ul className={styles.plan}>
              <li>
                <span>Drawings in the book&apos;s style</span>
                <span className={ui.muted}>{drawings}</span>
              </li>
              <li>
                <span>
                  {pageIndexes.length} {pageIndexes.length === 1 ? 'page' : 'pages'}, one image per character on each
                </span>
                <span className={ui.muted}>{pageImages}</span>
              </li>
              <li className={styles.total}>
                <span>
                  {images} images · about {money(images * price)}
                </span>
                <span className={ui.muted}>+ redraws the check asks for</span>
              </li>
            </ul>
          </div>
        )}

        {error && (
          <p className={cx(ui.notice, ui.noticeError)}>
            <span className={ui.dot} />
            {error}
          </p>
        )}

        <div className={styles.footer}>
          <button className={cx(ui.btn, ui.primary, ui.wide)} onClick={generate} disabled={!book || !assignments.length || !pageIndexes.length || busy}>
            {busy && <span className={ui.spinner} />}
            Generate
          </button>
          {book && assignments.length > 0 && !pageIndexes.length && <span className={ui.help}>None of these characters are on a page yet. Prepare the book first.</span>}
        </div>
      </div>

      <People people={people} setPeople={setPeople} />
    </div>
  );
}
