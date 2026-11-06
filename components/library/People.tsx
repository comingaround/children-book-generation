'use client';

import { useEffect, useRef, useState } from 'react';

import { cx } from '@/lib/client';
import { createPerson, updatePerson } from '@/lib/local/people';
import { deletePerson, deletePhoto } from '@/lib/local/store';
import { fileUrl, genderLabel, GENDERS, type Gender, type Person } from '@/lib/types';

import { PlusIcon } from '../icons';
import ui from '../ui.module.css';
import styles from './People.module.css';

interface Draft {
  name: string;
  gender: Gender;
  age: string;
  notes: string;
  photo: File | null;
  preview: string | null;
  consent: boolean;
}

const blankDraft: Draft = { name: '', gender: 'boy', age: '', notes: '', photo: null, preview: null, consent: false };

const draftOf = (p: Person): Draft => ({ name: p.name, gender: p.gender, age: p.age?.toString() ?? '', notes: p.notes, photo: null, preview: null, consent: true });

interface Props {
  /** Everyone saved in this browser; undefined while loading. */
  people: Person[] | undefined;
  /** Opens the new-person form with this gender (from "Add a photo" under Who is who); `n` changes per request. */
  request?: { n: number; gender: Gender } | null;
  /** A new person was saved. */
  onAdded?: (person: Person) => void;
}

/** Everyone who can be put into a book: children, parents, friends. Each needs a photo. */
export function People({ people: loaded, request, onAdded }: Props) {
  const people = loaded ?? [];
  const panel = useRef<HTMLDivElement>(null);
  // Until the list is loaded, nothing is open; then the newest person (or the form, if none).
  const [chosen, setOpenId] = useState<string | null>(null);
  const openId = chosen ?? (loaded ? (people[0]?.id ?? 'new') : null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const person = people.find((p) => p.id === openId) ?? null;
  const showForm = openId === 'new' || editing;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  function open(id: string) {
    setOpenId(id);
    setEditing(false);
    setError(null);
    setDraft(blankDraft);
  }

  // A new request opens the form right away (state adjusted while rendering); the effect only scrolls.
  const [seen, setSeen] = useState(request);
  if (request !== seen) {
    setSeen(request);
    if (request) {
      setOpenId('new');
      setEditing(false);
      setError(null);
      setDraft({ ...blankDraft, gender: request.gender });
    }
  }
  useEffect(() => {
    if (request) panel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [request]);

  function choosePhoto(file: File | undefined) {
    if (!file) return;
    if (draft.preview) URL.revokeObjectURL(draft.preview);
    set({ photo: file, preview: URL.createObjectURL(file) });
  }

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const fields = { name: draft.name, gender: draft.gender, age: draft.age, notes: draft.notes };
      const saved = editing && person ? await updatePerson(person.id, fields, draft.photo) : await createPerson(fields, draft.photo, draft.consent);
      if (!editing) onAdded?.(saved);
      open(saved.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(photoOnly: boolean) {
    if (!person) return;
    const question = photoOnly
      ? `Delete ${person.name}'s photo and the drawings made from it?`
      : `Remove ${person.name} completely? Runs stay, but show "Deleted person".`;
    if (!window.confirm(question)) return;
    setBusy('delete');
    try {
      if (photoOnly) {
        await deletePhoto(person.id);
      } else {
        await deletePerson(person.id);
        open(people.find((p) => p.id !== person.id)?.id ?? 'new');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={ui.panel} ref={panel}>
      <div className={ui.section}>
        <h2 className={ui.panelTitle}>People</h2>
        <div className={styles.people}>
          {people.map((p) => (
            <button key={p.id} className={cx(styles.person, p.id === openId && styles.personOn)} onClick={() => open(p.id)} aria-pressed={p.id === openId}>
              <span className={styles.avatar}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {p.photo ? <img src={fileUrl(p.photo)} alt="" /> : <span>{p.name[0]}</span>}
              </span>
              {p.name}
            </button>
          ))}
          <button className={cx(styles.person, openId === 'new' && styles.personOn)} onClick={() => open('new')} aria-pressed={openId === 'new'}>
            <span className={styles.avatar}>
              <PlusIcon />
            </span>
            New person
          </button>
        </div>

        {showForm ? (
          <div className={styles.form}>
            <label
              className={cx(styles.drop, (draft.preview || (editing && person?.photo)) && styles.dropFilled)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                choosePhoto(e.dataTransfer.files[0]);
              }}
            >
              <input type="file" accept="image/*" className={ui.srOnly} onChange={(e) => choosePhoto(e.target.files?.[0])} />
              {draft.preview || (editing && person?.photo) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={draft.preview ?? fileUrl(person!.photo!)} alt="" />
              ) : (
                <span className={styles.dropText}>
                  <strong>Drop a photo</strong>
                  <span>or click to choose · face clearly visible, good light</span>
                </span>
              )}
            </label>
            <div className={styles.pair}>
              <label className={ui.field}>
                <span className={ui.label}>Name</span>
                <input className={ui.input} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Emma" />
              </label>
              <label className={cx(ui.field, styles.age)}>
                <span className={ui.label}>Age</span>
                <input className={ui.input} inputMode="numeric" value={draft.age} onChange={(e) => set({ age: e.target.value.replace(/\D/g, '').slice(0, 3) })} placeholder="5" />
              </label>
            </div>
            <div className={ui.field}>
              <span className={ui.label}>Gender</span>
              <div className={ui.segmented} role="group" aria-label="Gender">
                {GENDERS.map((g) => (
                  <button key={g.value} className={ui.segment} aria-pressed={draft.gender === g.value} onClick={() => set({ gender: g.value })}>
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            <label className={ui.field}>
              <span className={ui.label}>Notes</span>
              <input className={ui.input} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. wears round glasses, curly hair, beard" />
            </label>
            {!editing && (
              <label className={styles.consent}>
                <input type="checkbox" checked={draft.consent} onChange={(e) => set({ consent: e.target.checked })} />
                <span>I am this person or their parent or guardian, and I agree that the photo is used to make this book. It is deleted when I ask.</span>
              </label>
            )}
            {error && (
              <p className={cx(ui.notice, ui.noticeError)}>
                <span className={ui.dot} />
                {error}
              </p>
            )}
            <div className={ui.row}>
              <button className={cx(ui.btn, ui.secondary)} onClick={save} disabled={busy === 'save' || !draft.name.trim() || (!editing && (!draft.photo || !draft.consent))}>
                {busy === 'save' && <span className={ui.spinner} />}
                {editing ? 'Save changes' : 'Save person'}
              </button>
              {editing && (
                <button className={cx(ui.btn, ui.ghost)} onClick={() => person && open(person.id)}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : (
          person && (
            <div className={styles.profile}>
              <span className={styles.photo}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {person.photo ? <img src={fileUrl(person.photo)} alt={`Photo of ${person.name}`} /> : <span className={ui.muted}>No photo</span>}
              </span>
              <div className={styles.profileText}>
                <strong>{person.name}</strong>
                <span className={ui.muted}>
                  {genderLabel(person.gender)}
                  {person.age !== null && `, ${person.age}`}
                </span>
                {person.notes && <span className={styles.notes}>{person.notes}</span>}
                {error && <span className={styles.error}>{error}</span>}
                <div className={styles.profileActions}>
                  <button
                    className={cx(ui.btn, ui.ghost, ui.small)}
                    onClick={() => {
                      setDraft(draftOf(person));
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                  {person.photo ? (
                    <button className={cx(ui.btn, ui.danger, ui.small)} onClick={() => remove(true)} disabled={!!busy}>
                      Delete photo
                    </button>
                  ) : (
                    <button className={cx(ui.btn, ui.ghost, ui.small)} onClick={() => remove(false)} disabled={!!busy}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        )}
        <span className={ui.help}>Photos stay in this browser and are sent to Google only while generating.</span>
      </div>
    </div>
  );
}
