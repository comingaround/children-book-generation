/** Shapes of the JSON files under data/. Shared by the server and the browser. */

export type Gender = 'boy' | 'girl';
export type PageKind = 'cover' | 'page' | 'skip';
export type Align = 'left' | 'center' | 'right';

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

export interface Page {
  index: number;
  kind: PageKind;
  image: string;
  thumb: string;
  imageWidth: number;
  imageHeight: number;
  /** Where the illustration sits on the page: [x0, y0, x1, y1] in percent. */
  imageRect: [number, number, number, number];
  hasProtagonist: boolean;
  box: Box | null;
  characterHint: string;
  /** Pose and direction of the main character here, e.g. "back to the viewer, looking left". */
  pose?: string;
  /** Outfit on this page when it differs from the book's; empty = the book's clothing. */
  clothing?: string;
  scenePrompt: string;
  lines: TextLine[];
}

export interface BookSettings {
  artStyle: string;
  protagonistName: string;
  protagonistGender: Gender;
  /** How to recognise the main character, without clothing: age, build, hair. */
  protagonistDescription: string;
  /** Their usual outfit; kept on every page. */
  clothing?: string;
  /** Paste the AI result back only inside the hero's box, so the rest stays pixel-identical. */
  keepOutsideBox: boolean;
  /** White outline around the page text, for text set over busy art. */
  textHalo: boolean;
}

export interface Book {
  id: string;
  title: string;
  source: string;
  importedAt: string;
  pageWidth: number;
  pageHeight: number;
  fonts: BookFont[];
  settings: BookSettings;
  pages: Page[];
}

export interface Child {
  id: string;
  name: string;
  gender: Gender;
  age: number | null;
  notes: string;
  photo: string | null;
  createdAt: string;
  /** Approved character drawings, by book id. */
  characters: Record<string, string>;
}

export interface Attempt {
  file: string;
  at: string;
  ms: number;
  /** The short correction this version was made with, if any. */
  fix?: string;
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
}

export type RunStatus = 'character' | 'review' | 'pages' | 'done';

export interface Run {
  id: string;
  bookId: string;
  childId: string;
  createdAt: string;
  status: RunStatus;
  pageIndexes: number[];
  character: RunStep & { approved: boolean; reused: boolean };
  pages: Record<string, RunStep>;
  /** Images generated in this run, for the cost counter. */
  images: number;
}

export interface RunSummary {
  id: string;
  bookId: string;
  bookTitle: string;
  childName: string;
  createdAt: string;
  status: RunStatus;
  done: number;
  total: number;
  cover: string | null;
}

/** Where a file under data/ is served from. */
export const fileUrl = (path: string) => `/api/files/${path}`;

export const storyPages = (book: Book) => book.pages.filter((p) => p.kind !== 'skip');

export type PageState = 'skip' | 'noHero' | 'ready' | 'needsBox';

/** For the status dots: a hero page is ready once the hero has a box. */
export function pageState(page: Page): PageState {
  if (page.kind === 'skip') return 'skip';
  if (!page.hasProtagonist) return 'noHero';
  return page.box ? 'ready' : 'needsBox';
}

/** Which pages a run makes: the cover plus the first `count` story pages that show the hero. */
export function testPages(book: Book, count: number | 'all'): number[] {
  const withHero = book.pages.filter((p) => p.kind !== 'skip' && p.hasProtagonist);
  const cover = withHero.filter((p) => p.kind === 'cover');
  const rest = withHero.filter((p) => p.kind === 'page');
  return [...cover, ...(count === 'all' ? rest : rest.slice(0, count))].map((p) => p.index);
}
