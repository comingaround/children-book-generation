/**
 * Shapes of books (JSON files under data/, on the server) and of people and runs (kept in the
 * browser, see lib/local/). Shared by the server and the browser.
 */

import { LOCAL, localUrl } from './local/urls';

export type Gender = 'boy' | 'girl' | 'man' | 'woman';
export type PageKind = 'cover' | 'page' | 'skip';
export type Align = 'left' | 'center' | 'right';

export const GENDERS: { value: Gender; label: string }[] = [
  { value: 'boy', label: 'Boy' },
  { value: 'girl', label: 'Girl' },
  { value: 'man', label: 'Man' },
  { value: 'woman', label: 'Woman' },
];

export const genderLabel = (g: Gender) => GENDERS.find((x) => x.value === g)?.label ?? g;

/** A rectangle in percent of the illustration (0–100). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One line of page text, positioned in percent of the page. `size` is percent of page width. */
export interface TextLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  font: string | null;
  color: string;
  align: Align;
  /** The line as printed in the PDF, when the import cleaned it (markup removed, a fragment joined). */
  source?: string;
}

export interface BookFont {
  family: string;
  file: string;
  pdfName: string;
  weight: number;
  italic: boolean;
  fallback: string;
}

/** A character of the book who can be replaced by a real person. */
export interface BookCharacter {
  id: string;
  /** Shown in the editor, e.g. "Ross" or "Mommy". */
  label: string;
  /** Swapped for the person's name in the page text; empty = no swap. */
  nameInText: string;
  gender: Gender;
  /** How to recognise them, without clothing: age, build, hair. */
  description: string;
  /** Their usual outfit; kept on every page. */
  clothing: string;
}

/** One character on one page. */
export interface PageCast {
  present: boolean;
  box: Box | null;
  /** Picks them out from everyone else in this picture. */
  hint: string;
  /** Pose and direction here, e.g. "back to the viewer, looking left". */
  pose: string;
  /** Outfit on this page when it differs from their usual one; empty = usual. */
  clothing: string;
}

export interface Page {
  index: number;
  kind: PageKind;
  image: string;
  thumb: string;
  imageWidth: number;
  imageHeight: number;
  /** Where the illustration sits on the page: [x0, y0, x1, y1] in percent. */
  imageRect: [number, number, number, number];
  /** By character id. A missing entry means the character isn't on this page. */
  cast: Record<string, PageCast>;
  scenePrompt: string;
  lines: TextLine[];
  /** PDF lines left out of the story (ads, markup); the PDF export removes them. */
  removed?: string[];
}

export interface BookSettings {
  artStyle: string;
  /** Paste the AI result back only inside a character's box, so the rest stays pixel-identical. */
  keepOutsideBox: boolean;
  /** White outline around the page text, for text set over busy art. */
  textHalo: boolean;
  /** Send the model a close-up around the box instead of the whole page (default on). */
  closeUp?: boolean;
}

export interface Book {
  id: string;
  /** Imported in this browser and kept there (lib/local/books.ts); else a book in data/books/ on the server. */
  local?: boolean;
  title: string;
  source: string;
  importedAt: string;
  pageWidth: number;
  pageHeight: number;
  fonts: BookFont[];
  characters: BookCharacter[];
  settings: BookSettings;
  pages: Page[];
}

/** A real person who can be put into a book (kept in the browser; files under data/children/ before). */
export interface Person {
  id: string;
  name: string;
  gender: Gender;
  age: number | null;
  notes: string;
  photo: string | null;
  createdAt: string;
  /** When whoever uploaded the photo confirmed they may use it (customer flow). */
  consentAt?: string;
  /** Approved drawings (file keys), by `${bookId}/${characterId}`. */
  drawings: Record<string, string>;
}

export interface Attempt {
  file: string;
  at: string;
  ms: number;
  /** The short correction this version was made with, if any. */
  fix?: string;
  /** Which character `fix` was for; absent = everyone on the page. */
  fixFor?: string;
  /** Made with every character in one image call. */
  together?: boolean;
}

/** Longest correction accepted with a Regenerate: enough for "facing away from us, like the original". */
export const FIX_MAX = 120;

export type StepStatus = 'waiting' | 'queued' | 'working' | 'done' | 'error';

export interface RunStep {
  status: StepStatus;
  attempts: Attempt[];
  selected: number | null;
  message: string | null;
  /** Correction waiting for the next attempt. */
  fix?: string | null;
  /** Which character the correction is for; null = everyone on the page. */
  fixFor?: string | null;
}

/** Step 1 for one character: the person drawn in the book's style. */
export interface CastStep extends RunStep {
  characterId: string;
  personId: string;
  approved: boolean;
  reused: boolean;
}

export type RunStatus = 'character' | 'review' | 'pages' | 'done';

export interface Run {
  id: string;
  bookId: string;
  createdAt: string;
  status: RunStatus;
  pageIndexes: number[];
  /** Every character on a page in one image call instead of one call each. */
  together?: boolean;
  /** Started as a customer's free preview (cover + 1 page), protected from saving until ordered. */
  preview?: boolean;
  /** The customer ordered the full book: every page with their characters was added. */
  ordered?: boolean;
  /**
   * Page text rewritten for this run's people (names, and he/she where a person's gender differs
   * from their character's), by page index: one string per line of `page.lines`. Absent = names only.
   */
  text?: Record<string, string[]>;
  /** The he/she rewrite: being made, or failed (the pages then show the names swapped only). */
  textStatus?: 'working' | 'done' | 'error';
  cast: CastStep[];
  pages: Record<string, RunStep>;
  /** Images generated in this run, for the cost counter. */
  images: number;
  /** How many of them were character drawings (the rest are page images). Missing on older runs. */
  drawings?: number;
}

export interface RunSummary {
  id: string;
  bookId: string;
  bookTitle: string;
  people: string;
  createdAt: string;
  status: RunStatus;
  preview: boolean;
  ordered: boolean;
  done: number;
  total: number;
  /** Images generated, for the owner's cost column. */
  images: number;
  cover: string | null;
}

/**
 * A finished run published with the site (data/examples/<id>/example.json), for visitors to see
 * what the engine makes before they try it. Its files are paths under data/ like books' files.
 */
export interface Example {
  id: string;
  bookId: string;
  publishedAt: string;
  /** The run with only the version each step shows, its files moved into the example's folder. */
  run: Run;
  /** Who plays whom: their photo and their drawing in the book's style. */
  cast: (PersonFacts & { characterId: string; photo: string; drawing: string })[];
  /** The finished book as a PDF, made when it was published. */
  pdf: string;
}

/** An example as the home page shows it. */
export interface ExampleCard {
  id: string;
  title: string;
  people: string[];
  pages: number;
  /** The generated cover (or first page). */
  cover: string;
  /** The book's page shape, as a CSS aspect ratio. */
  ratio: string;
}

/** One of our sample people (lib/local/samples.ts). */
export interface SamplePerson extends PersonFacts {
  id: string;
  /** Paths under data/ on the server. */
  photo: string;
  drawings: Record<string, string>;
}

/** The examples' casts, one person per name (server side, for the page to pass on). */
export function samplePeople(examples: Example[]): SamplePerson[] {
  const byName = new Map<string, SamplePerson>();
  for (const e of examples) {
    for (const p of e.cast) {
      const known = byName.get(p.name);
      if (known) {
        known.drawings[drawingKey(e.bookId, p.characterId)] = p.drawing;
        continue;
      }
      byName.set(p.name, {
        id: `person-sample-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: p.name,
        gender: p.gender,
        age: p.age,
        notes: '',
        photo: p.photo,
        drawings: { [drawingKey(e.bookId, p.characterId)]: p.drawing },
      });
    }
  }
  return [...byName.values()];
}

/** What the prompts say about a person; all the AI endpoints get, besides the photo. */
export type PersonFacts = Pick<Person, 'name' | 'gender' | 'age' | 'notes'>;

export const personFacts = ({ name, gender, age, notes }: Person): PersonFacts => ({ name, gender, age, notes });

/** Where a file is shown from: this browser's storage (people, runs) or data/ on the server (books). */
export const fileUrl = (path: string) => (path.startsWith(LOCAL) ? localUrl(path) : `/api/files/${path}`);

/**
 * The art a person's drawing is made from: the cover (for the style) and the first page where
 * the character has a box (their outfit and build). A browser book sends these with the call.
 */
export function characterArt(book: Book, characterId: string): { style: Page; sample: Page | undefined } {
  const style = book.pages.find((p) => p.kind === 'cover') ?? book.pages[0];
  const sample = book.pages.find((p) => p.kind !== 'skip' && p.cast[characterId]?.present && p.cast[characterId].box);
  return { style, sample };
}

/** The art "Prepare with AI" reads: a few pages for the whole book, or the one page `index`. */
export function draftImages(book: Book, index?: number): string[] {
  if (index !== undefined) return book.pages.filter((p) => p.index === index).map((p) => p.image);
  const story = book.pages.filter((p) => p.kind === 'page');
  return [book.pages.find((p) => p.kind === 'cover'), story[1], story[Math.floor(story.length / 2)]].filter((p) => !!p).map((p) => p.image);
}

/** A book's own file (page art, thumb, font), wherever the book is kept. */
export const bookFile = (book: Pick<Book, 'id' | 'local'>, path: string) => `${book.local ? LOCAL : ''}books/${book.id}/${path}`;

export const drawingKey = (bookId: string, characterId: string) => `${bookId}/${characterId}`;

export const castOn = (page: Page, characterId: string): PageCast =>
  page.cast[characterId] ?? { present: false, box: null, hint: '', pose: '', clothing: '' };

/** Characters on a page, in the book's order. */
export const presentOn = (book: Book, page: Page) => book.characters.filter((c) => page.cast[c.id]?.present);

/** The version a step shows: the one picked, else the newest. */
export const chosenIndex = (step: { attempts: unknown[]; selected: number | null }) => step.selected ?? step.attempts.length - 1;

export const chosenFile = (step: { attempts: { file: string }[]; selected: number | null }): string | null => step.attempts[chosenIndex(step)]?.file ?? null;

/**
 * Whether the given characters on a page can be drawn in one image call ("all at once"): more
 * than one of them is there, close-ups are on, and every one of them has a box. Otherwise a run
 * set to all at once draws that page one by one.
 */
export function canDrawTogether(book: Book, page: Page, characterIds: string[]): boolean {
  const here = characterIds.filter((id) => page.cast[id]?.present);
  return here.length > 1 && book.settings.closeUp !== false && here.every((id) => page.cast[id].box);
}

/** Page images these pages cost: one per character on each, or one per page drawn all at once. */
export function pageImageCount(book: Book, indexes: number[], characterIds: string[], together: boolean): number {
  return indexes.reduce((n, i) => {
    const page = book.pages.find((p) => p.index === i);
    if (!page) return n;
    return n + (together && canDrawTogether(book, page, characterIds) ? 1 : characterIds.filter((id) => page.cast[id]?.present).length);
  }, 0);
}

export type PageState = 'skip' | 'noCast' | 'ready' | 'needsBox';

/** For the status dots: a page is ready once every character on it has a box. */
export function pageState(book: Book, page: Page): PageState {
  if (page.kind === 'skip') return 'skip';
  const present = presentOn(book, page);
  if (!present.length) return 'noCast';
  return present.every((c) => page.cast[c.id].box) ? 'ready' : 'needsBox';
}

/** Pages with characters on them, and how many of those have every box drawn. */
export function pageReadiness(book: Book): { ready: number; total: number } {
  const states = book.pages.map((p) => pageState(book, p)).filter((s) => s === 'ready' || s === 'needsBox');
  return { ready: states.filter((s) => s === 'ready').length, total: states.length };
}

/** Boy and man are one side, girl and woman the other: a swap across them needs he/she changed. */
export const isMale = (g: Gender) => g === 'boy' || g === 'man';

/** Customers only see books where every page with a character has every box drawn. */
export function bookReady(book: Book): boolean {
  const { ready, total } = pageReadiness(book);
  return book.characters.length > 0 && total > 0 && ready === total;
}

/** Story pages in a free preview, after the cover. */
export const PREVIEW_PAGES = 1;

/** Which pages a run makes: the cover plus the first `count` story pages with any of `characterIds`. */
export function testPages(book: Book, count: number | 'all', characterIds: string[]): number[] {
  const withCast = book.pages.filter((p) => p.kind !== 'skip' && characterIds.some((id) => p.cast[id]?.present));
  const cover = withCast.filter((p) => p.kind === 'cover');
  const rest = withCast.filter((p) => p.kind === 'page');
  return [...cover, ...(count === 'all' ? rest : rest.slice(0, count))].map((p) => p.index);
}
