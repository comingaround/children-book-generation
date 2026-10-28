'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ago, api, cx } from '@/lib/client';
import { fileUrl, genderLabel, PREVIEW_PAGES, testPages, type Book, type BookCharacter, type Gender, type Person, type Run, type RunSummary } from '@/lib/types';

import { CheckIcon, PlusIcon } from '../icons';
import { BookCard } from '../library/BookCard';
import lib from '../library/Library.module.css';
import { People } from '../library/People';
import { RunStatusChip } from '../RunStatusChip';
import ui from '../ui.module.css';
import styles from './MakeBook.module.css';

interface Props {
  /** Only books that are fully prepared. */
  books: Book[];
  initialPeople: Person[];
  runs: RunSummary[];
}

/** What a customer sees: choose a book → a photo for each character → a free preview. */
export function MakeBook({ books, initialPeople, runs }: Props) {
  const router = useRouter();
  const [bookId, setBookId] = useState<string | null>(null);
  const [people, setPeople] = useState(initialPeople);
  /** Person id by character id, per book, so switching books keeps each book's choices. */
  const [cast, setCast] = useState<Record<string, Record<string, string>>>({});
  /** The character waiting for the person being added in the People card. */
  const [adding, setAdding] = useState<string | null>(null);
  const [request, setRequest] = useState<{ n: number; gender: Gender } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const book = books.find((b) => b.id === bookId) ?? null;
  const chosen = (book && cast[book.id]) || {};
  const withPhoto = (id: string | undefined) => people.find((p) => p.id === id && p.photo);
  const assignments = book ? book.characters.filter((c) => withPhoto(chosen[c.id])).map((c) => ({ characterId: c.id, personId: chosen[c.id] })) : [];
  const previewPages = book
    ? testPages(
        book,
        PREVIEW_PAGES,
        assignments.map((a) => a.characterId),
      )
    : [];
  const names = assignments.map((a) => withPhoto(a.personId)!.name);

  const assign = (characterId: string, personId: string) => book && setCast((all) => ({ ...all, [book.id]: { ...all[book.id], [characterId]: personId } }));

  function choose(id: string) {
    setBookId(id);
    setAdding(null);
    setError(null);
  }

  async function start() {
    if (!book) return;
    setBusy(true);
    setError(null);
    try {
      const run = await api<Run>('/api/runs', { method: 'POST', json: { bookId: book.id, assignments, pages: 'preview', reuseDrawings: true } });
      router.push(`/preview/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className={lib.layout}>
      <div className={cx(lib.main, styles.steps)}>
        <header className={styles.hero}>
          <h1 className={styles.title}>Put your child into a picture book</h1>
          <p className={ui.muted}>Choose a book, add a photo for each character, and see a free preview of your own book in a few minutes.</p>
        </header>

        <section className={styles.step}>
          <StepHead n={1} title="Choose a book" done={!!book} />
          {books.length === 0 ? (
            <p className={ui.muted}>
              No books are ready yet. They are added and prepared under <Link href="/studio">Edit books</Link>.
            </p>
          ) : (
            <ul className={lib.grid}>
              {books.map((b) => (
                <BookCard key={b.id} book={b} selected={b.id === bookId} onSelect={() => choose(b.id)} />
              ))}
            </ul>
          )}
        </section>

        {book && (
          <section className={styles.step}>
            <StepHead n={2} title="Who is who?" done={assignments.length > 0} />
            <p className={ui.muted}>Add a photo for anyone you want in the book. Characters you leave as they are stay as in the book.</p>
            <ul className={styles.cast}>
              {book.characters.map((c) => {
                const takenBy = new Set(
                  Object.entries(chosen)
                    .filter(([id, p]) => id !== c.id && p)
                    .map(([, p]) => p),
                );
                return (
                  <li key={c.id} className={styles.castRow}>
                    <div className={styles.character}>
                      <CharacterCrop book={book} character={c} />
                      <span className={styles.characterText}>
                        <strong>{c.label}</strong>
                        <span className={ui.muted}>{genderLabel(c.gender).toLowerCase()} in the book</span>
                      </span>
                    </div>
                    <div className={styles.choices} role="group" aria-label={`Who plays ${c.label}`}>
                      <button className={cx(styles.choice, !chosen[c.id] && styles.choiceOn)} onClick={() => assign(c.id, '')} aria-pressed={!chosen[c.id]}>
                        As in the book
                      </button>
                      {people
                        .filter((p) => p.photo && !takenBy.has(p.id))
                        .map((p) => (
                          <button
                            key={p.id}
                            className={cx(styles.choice, chosen[c.id] === p.id && styles.choiceOn)}
                            onClick={() => assign(c.id, p.id)}
                            aria-pressed={chosen[c.id] === p.id}
                          >
                            <span className={styles.avatar}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={fileUrl(p.photo!)} alt="" />
                            </span>
                            {p.name}
                          </button>
                        ))}
                      <button
                        className={cx(styles.choice, styles.add, adding === c.id && styles.choiceOn)}
                        onClick={() => {
                          setAdding(c.id);
                          setRequest({ n: Date.now(), gender: c.gender });
                        }}
                      >
                        <PlusIcon />
                        Add a photo
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {book && assignments.length > 0 && (
          <section className={styles.step}>
            <StepHead n={3} title="See your free preview" done={false} />
            <p className={ui.muted}>
              We draw {names.join(' and ')} in the book&apos;s style, then the cover{previewPages.length > 2 ? ` and ${previewPages.length - 1} pages` : ' and one page'}. It takes
              about two minutes. You check them before ordering the whole book.
            </p>
            {error && (
              <p className={cx(ui.notice, ui.noticeError)}>
                <span className={ui.dot} />
                {error}
              </p>
            )}
            <div>
              <button className={cx(ui.btn, ui.primary)} onClick={start} disabled={busy || !previewPages.length}>
                {busy && <span className={ui.spinner} />}
                Make my free preview
              </button>
            </div>
          </section>
        )}

        {runs.length > 0 && (
          <section className={styles.step}>
            <h2 className={ui.panelTitle}>Your books</h2>
            <ul className={lib.runList}>
              {runs.slice(0, 12).map((run) => (
                <li key={run.id}>
                  <Link href={`/preview/${run.id}`} className={lib.runRow}>
                    <span className={lib.runThumb}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {run.cover && <img src={fileUrl(run.cover)} alt="" />}
                    </span>
                    <span className={lib.runText}>
                      <strong>{run.bookTitle}</strong>
                      <span className={ui.muted} suppressHydrationWarning>
                        {run.people} · {run.ordered ? 'full book' : 'preview'} · {ago(run.createdAt)}
                      </span>
                    </span>
                    <RunStatusChip status={run.status} done={run.done} total={run.total} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className={lib.side}>
        <People
          people={people}
          setPeople={setPeople}
          request={request}
          onAdded={(person) => {
            if (adding) assign(adding, person.id);
            setAdding(null);
          }}
        />
      </aside>
    </main>
  );
}

function StepHead({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <div className={styles.stepHead}>
      <span className={cx(styles.num, done && styles.numDone)}>{done ? <CheckIcon /> : n}</span>
      <h2 className={styles.stepTitle}>{title}</h2>
    </div>
  );
}

/** The character as drawn in the book: their box on the cover, else on the first page that has one. */
function CharacterCrop({ book, character }: { book: Book; character: BookCharacter }) {
  const pages = book.pages.filter((p) => p.kind !== 'skip' && p.cast[character.id]?.box);
  const page = pages.find((p) => p.kind === 'cover') ?? pages[0];
  if (!page) return <span className={styles.crop} />;
  const { x, y, w, h } = page.cast[character.id].box!;
  const at = (start: number, size: number) => (size >= 100 ? 0 : (start / (100 - size)) * 100);
  return (
    <span
      className={styles.crop}
      style={{
        aspectRatio: `${w * page.imageWidth} / ${h * page.imageHeight}`,
        backgroundImage: `url(${fileUrl(`books/${book.id}/${page.image}`)})`,
        backgroundSize: `${10000 / w}% ${10000 / h}%`,
        backgroundPosition: `${at(x, w)}% ${at(y, h)}%`,
      }}
      role="img"
      aria-label={`${character.label} in the book`}
    />
  );
}
