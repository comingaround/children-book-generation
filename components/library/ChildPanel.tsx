'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, cx, money } from '@/lib/client';
import { fileUrl, testPages, type Book, type Child, type Gender, type Run } from '@/lib/types';

import { PlusIcon } from '../icons';
import ui from '../ui.module.css';
import styles from './ChildPanel.module.css';

interface Draft {
  name: string;
  gender: Gender;
  age: string;
  notes: string;
  photo: File | null;
  preview: string | null;
}

const blankDraft: Draft = { name: '', gender: 'boy', age: '', notes: '', photo: null, preview: null };

const draftOf = (c: Child): Draft => ({ name: c.name, gender: c.gender, age: c.age?.toString() ?? '', notes: c.notes, photo: null, preview: null });

export function ChildPanel({ book: selectedBook, initialChildren, price }: { book: Book | null; initialChildren: Child[]; price: number }) {
  const books = selectedBook ? [selectedBook] : [];
  const router = useRouter();
  const [children, setChildren] = useState(initialChildren);
  const [childId, setChildId] = useState<string>(initialChildren[0]?.id ?? 'new');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [mode, setMode] = useState<'test' | 'all'>('test');
  const [reuse, setReuse] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const child = children.find((c) => c.id === childId) ?? null;
  const showForm = childId === 'new' || editing;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  function pickChild(id: string) {
    setChildId(id);
    setEditing(false);
    setError(null);
    setDraft(blankDraft);
  }

  function choosePhoto(file: File | undefined) {
    if (!file) return;
    if (draft.preview) URL.revokeObjectURL(draft.preview);
    set({ photo: file, preview: URL.createObjectURL(file) });
  }

  async function saveChild() {
    setBusy('save');
    setError(null);
    try {
      const form = new FormData();
      form.set('name', draft.name);
      form.set('gender', draft.gender);
      form.set('age', draft.age);
      form.set('notes', draft.notes);
      if (draft.photo) form.set('photo', draft.photo);
      const saved = await api<Child>(editing && child ? `/api/children/${child.id}` : '/api/children', {
        method: editing ? 'PATCH' : 'POST',
        body: form,
      });
      setChildren((list) => [saved, ...list.filter((c) => c.id !== saved.id)]);
      pickChild(saved.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function removeChild(photoOnly: boolean) {
    if (!child) return;
    const question = photoOnly
      ? `Delete ${child.name}'s photo and the character drawings made from it?`
      : `Remove ${child.name} completely? Runs stay, but show "Deleted child".`;
    if (!window.confirm(question)) return;
    setBusy('delete');
    try {
      if (photoOnly) {
        const updated = await api<Child>(`/api/children/${child.id}?photo=1`, { method: 'DELETE' });
        setChildren((list) => list.map((c) => (c.id === updated.id ? updated : c)));
      } else {
        await api(`/api/children/${child.id}`, { method: 'DELETE' });
        const rest = children.filter((c) => c.id !== child.id);
        setChildren(rest);
        pickChild(rest[0]?.id ?? 'new');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    if (!child) return;
    setBusy('generate');
    setError(null);
    try {
      const run = await api<Run>('/api/runs', { method: 'POST', json: { bookId: books[0].id, childId: child.id, pages: mode, reuseCharacter: reuse } });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  const plan = books.map((book) => {
    const pages = testPages(book, mode === 'all' ? 'all' : 3).length;
    const hasCharacter = !!child?.characters[book.id];
    return { book, pages, character: !(reuse && hasCharacter), hasCharacter };
  });
  const images = plan.reduce((n, p) => n + p.pages + (p.character ? 1 : 0), 0);
  const anySaved = plan.some((p) => p.hasCharacter);
  const canGenerate = !!child?.photo && books.length > 0 && !showForm && images > 0;

  return (
    <div className={ui.panel}>
      <div className={ui.section}>
        <h2 className={ui.panelTitle}>New run</h2>
        <span className={ui.eyebrow}>Child</span>
        <div className={styles.people}>
          {children.map((c) => (
            <button key={c.id} className={cx(styles.person, c.id === childId && styles.personOn)} onClick={() => pickChild(c.id)} aria-pressed={c.id === childId}>
              <span className={styles.avatar}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {c.photo ? <img src={fileUrl(c.photo)} alt="" /> : <span>{c.name[0]}</span>}
              </span>
              {c.name}
            </button>
          ))}
          <button className={cx(styles.person, childId === 'new' && styles.personOn)} onClick={() => pickChild('new')} aria-pressed={childId === 'new'}>
            <span className={styles.avatar}>
              <PlusIcon />
            </span>
            New child
          </button>
        </div>

        {showForm ? (
          <div className={styles.form}>
            <label
              className={cx(styles.drop, (draft.preview || (editing && child?.photo)) && styles.dropFilled)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                choosePhoto(e.dataTransfer.files[0]);
              }}
            >
              <input type="file" accept="image/*" className={ui.srOnly} onChange={(e) => choosePhoto(e.target.files?.[0])} />
              {draft.preview || (editing && child?.photo) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={draft.preview ?? fileUrl(child!.photo!)} alt="" />
              ) : (
                <span className={styles.dropText}>
                  <strong>Drop a photo</strong>
                  <span>or click to choose · face clearly visible, good light</span>
                </span>
              )}
            </label>
            <label className={ui.field}>
              <span className={ui.label}>Name</span>
              <input className={ui.input} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Emma" />
            </label>
            <div className={styles.pair}>
              <div className={ui.field}>
                <span className={ui.label}>Gender</span>
                <div className={ui.segmented} role="group" aria-label="Gender">
                  {(['boy', 'girl'] as const).map((g) => (
                    <button key={g} className={ui.segment} aria-pressed={draft.gender === g} onClick={() => set({ gender: g })}>
                      {g === 'boy' ? 'Boy' : 'Girl'}
                    </button>
                  ))}
                </div>
              </div>
              <label className={cx(ui.field, styles.age)}>
                <span className={ui.label}>Age</span>
                <input className={ui.input} inputMode="numeric" value={draft.age} onChange={(e) => set({ age: e.target.value.replace(/\D/g, '').slice(0, 2) })} placeholder="5" />
              </label>
            </div>
            <label className={ui.field}>
              <span className={ui.label}>Notes</span>
              <input className={ui.input} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. wears round glasses, curly hair" />
            </label>
            <div className={ui.row}>
              <button className={cx(ui.btn, ui.secondary)} onClick={saveChild} disabled={busy === 'save' || !draft.name.trim() || (!editing && !draft.photo)}>
                {busy === 'save' && <span className={ui.spinner} />}
                {editing ? 'Save changes' : 'Save child'}
              </button>
              {editing && (
                <button className={cx(ui.btn, ui.ghost)} onClick={() => pickChild(childId)}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : (
          child && (
            <div className={styles.profile}>
              <span className={styles.photo}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {child.photo ? <img src={fileUrl(child.photo)} alt={`Photo of ${child.name}`} /> : <span className={ui.muted}>No photo</span>}
              </span>
              <div className={styles.profileText}>
                <strong>{child.name}</strong>
                <span className={ui.muted}>
                  {child.gender === 'boy' ? 'Boy' : 'Girl'}
                  {child.age !== null && `, ${child.age}`}
                </span>
                {child.notes && <span className={styles.notes}>{child.notes}</span>}
                <div className={styles.profileActions}>
                  <button
                    className={cx(ui.btn, ui.ghost, ui.small)}
                    onClick={() => {
                      setDraft(draftOf(child));
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                  {child.photo ? (
                    <button className={cx(ui.btn, ui.danger, ui.small)} onClick={() => removeChild(true)} disabled={!!busy}>
                      Delete photo
                    </button>
                  ) : (
                    <button className={cx(ui.btn, ui.ghost, ui.small)} onClick={() => removeChild(false)} disabled={!!busy}>
                      Remove child
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        )}
      </div>

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
        {anySaved && (
          <label className={ui.switchRow}>
            <span className={styles.switchText}>
              Reuse the approved character
              <span className={ui.help}>Skips step 1 if this child already has an approved drawing for this book</span>
            </span>
            <input type="checkbox" className={ui.switch} checked={reuse} onChange={(e) => setReuse(e.target.checked)} />
          </label>
        )}
        {books.length === 0 ? (
          <p className={cx(ui.notice, ui.noticeInfo)}>
            <span className={ui.dot} />
            Select a book on the left.
          </p>
        ) : (
          <ul className={styles.plan}>
            {plan.map((p) => (
              <li key={p.book.id}>
                <span>{p.book.title}</span>
                <span className={ui.muted}>
                  {p.character ? 'character + ' : ''}
                  {p.pages} {p.pages === 1 ? 'page' : 'pages'}
                </span>
              </li>
            ))}
            <li className={styles.total}>
              <span>
                {images} images · about {money(images * price)}
              </span>
              <span className={ui.muted}>Nano Banana Pro, 2K</span>
            </li>
          </ul>
        )}
      </div>

      {error && (
        <p className={cx(ui.notice, ui.noticeError)}>
          <span className={ui.dot} />
          {error}
        </p>
      )}

      <div className={styles.footer}>
        <button className={cx(ui.btn, ui.primary, ui.wide)} onClick={generate} disabled={!canGenerate || busy === 'generate'}>
          {busy === 'generate' && <span className={ui.spinner} />}
          Generate
        </button>
        <p className={ui.help}>The photo stays in data/ on this computer and is sent to Google only while generating.</p>
      </div>
    </div>
  );
}
