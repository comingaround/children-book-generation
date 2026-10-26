/** Shapes of the JSON files under data/. Shared by the server and the browser. */

export type Gender = 'boy' | 'girl' | 'man' | 'woman';
export type PageKind = 'cover' | 'page' | 'skip';
export type Align = 'left' | 'center' | 'right';

export const GENDERS: { value: Gender; label: string }[] = [
  { value: 'boy', label: 'Boy' },
  { value: 'girl', label: 'Girl' },
  { value: 'man', label: 'Man' },
  { value: 'woman', label: 'Woman' },
];

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

/** A real person who can be put into a book (stored under data/children/). */
export interface Person {
  id: string;
  name: string;
  gender: Gender;
  age: number | null;
  notes: string;
  photo: string | null;
  createdAt: string;
  /** Approved drawings, by `${bookId}/${characterId}`. */
  drawings: Record<string, string>;
}

export interface Attempt {
  file: string;
  at: string;
  ms: number;
  /** The short correction this version was made with, if any. */
  fix?: string;
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
  cast: CastStep[];
  pages: Record<string, RunStep>;
  /** Images generated in this run, for the cost counter. */
  images: number;
}

export interface RunSummary {
  id: string;
  bookId: string;
  bookTitle: string;
  people: string;
  createdAt: string;
  status: RunStatus;
  done: number;
  total: number;
  cover: string | null;
}

/** Where a file under data/ is served from. */
export const fileUrl = (path: string) => `/api/files/${path}`;

export const drawingKey = (bookId: string, characterId: string) => `${bookId}/${characterId}`;

export const castOn = (page: Page, characterId: string): PageCast =>
  page.cast[characterId] ?? { present: false, box: null, hint: '', pose: '', clothing: '' };

/** Characters on a page, in the book's order. */
export const presentOn = (book: Book, page: Page) => book.characters.filter((c) => page.cast[c.id]?.present);

export const chosenFile = (step: { attempts: { file: string }[]; selected: number | null }): string | null =>
  step.attempts[step.selected ?? step.attempts.length - 1]?.file ?? null;

export type PageState = 'skip' | 'noHero' | 'ready' | 'needsBox';

/** For the status dots: a page is ready once every character on it has a box. */
export function pageState(book: Book, page: Page): PageState {
  if (page.kind === 'skip') return 'skip';
  const present = presentOn(book, page);
  if (!present.length) return 'noHero';
  return present.every((c) => page.cast[c.id].box) ? 'ready' : 'needsBox';
}

/** Which pages a run makes: the cover plus the first `count` story pages with any of `characterIds`. */
export function testPages(book: Book, count: number | 'all', characterIds: string[]): number[] {
  const withCast = book.pages.filter((p) => p.kind !== 'skip' && characterIds.some((id) => p.cast[id]?.present));
  const cover = withCast.filter((p) => p.kind === 'cover');
  const rest = withCast.filter((p) => p.kind === 'page');
  return [...cover, ...(count === 'all' ? rest : rest.slice(0, count))].map((p) => p.index);
}
