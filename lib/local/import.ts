import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

import type { Align, Book, BookFont, Page, PageKind, TextLine } from '../types';
import { deleteFiles, localKey, saveFile } from './files';
import { emit, newId } from './store';
import { put } from './idb';

/**
 * Imports a picture-book PDF in the browser, into this browser's storage: the same book
 * scripts/import_pdf.py makes on the server, rule for rule. For every page it keeps the
 * illustration without text (the largest image), the text lines with their position, font and
 * colour, and the fonts embedded in the PDF, so the page can be rebuilt with new art underneath.
 */

const THUMB_MAX = 720;
/** Page art is kept as JPEG (it goes to the AI with every call; Vercel takes at most 4.5 MB a request). */
const ART_MAX = 3000;
const AD_LINE = /advertisement|published by|www\.|\.com\b/i;
const CREDIT = /illustrat|written by|^by\b/i;
const SKIP_PAGE = /dear supporter|discover more|your story book|personalised children/i;
/** A word or two left on a line once markup is gone joins the next line. */
const FRAGMENT_WORDS = 2;

type Pdfjs = typeof import('pdfjs-dist');

let loading: Promise<Pdfjs> | null = null;

/** pdf.js is large; it loads only when someone imports a book. */
export function pdfjs(): Promise<Pdfjs> {
  loading ??= import('pdfjs-dist').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    return lib;
  });
  return loading;
}

/** Decoders for JPEG 2000 and JBIG2 images, CMaps, colour profiles (scripts/copy-pdfjs.mjs). */
export const PDFJS_FILES = {
  wasmUrl: '/pdfjs/wasm/',
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  iccUrl: '/pdfjs/iccs/',
  standardFontDataUrl: '/pdfjs/standard_fonts/',
};

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'book';

const titleFrom = (name: string) => name.replace(/[_-]+/g, ' ').trim().replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

const pct = (value: number, total: number) => Math.round((value / total) * 100 * 1000) / 1000;

function fallbackFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('comic')) return '"Comic Sans MS", "Comic Neue", cursive';
  if (['times', 'garamond', 'georgia', 'serif', 'americana', 'bookman', 'century'].some((k) => n.includes(k))) return 'Georgia, "Times New Roman", serif';
  return 'Arial, Helvetica, sans-serif';
}

// ---- text ------------------------------------------------------------------------------

/** One PDF text line, in page points from the top-left, before it becomes a TextLine. */
export interface RawLine {
  text: string;
  bbox: [number, number, number, number];
  /** Where its first letter sits on the line (points from the top), for setting new text there. */
  baseline: number;
  size: number;
  /** pdf.js's name for the first span's font (its loadedName). */
  fontId: string;
  color: string;
  source?: string;
}

/** The fill colour each piece of shown text was drawn in, in drawing order, one entry per letter. */
function textColors(lib: Pdfjs, ops: { fnArray: number[]; argsArray: unknown[][] }): { ch: string; color: string }[] {
  const { OPS } = lib;
  const out: { ch: string; color: string }[] = [];
  const stack: string[] = [];
  let color = '#000000';
  for (const [i, fn] of ops.fnArray.entries()) {
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(color);
    else if (fn === OPS.restore) color = stack.pop() ?? color;
    else if (fn === OPS.setFillRGBColor && typeof args?.[0] === 'string') color = args[0] as string;
    else if (fn === OPS.showText || fn === OPS.showSpacedText || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      const glyphs = args?.[fn === OPS.nextLineSetSpacingShowText ? 2 : 0];
      if (!Array.isArray(glyphs)) continue;
      // Glyphs are objects with `unicode`; numbers between them are spacing.
      for (const g of glyphs) {
        const unicode = g && typeof g === 'object' ? (g as { unicode?: string }).unicode : undefined;
        for (const ch of unicode ?? '') if (ch.trim()) out.push({ ch, color });
      }
    }
  }
  return out;
}

/** The page's text items grouped into lines (same baseline, close together), with their colours. */
function rawLines(lib: Pdfjs, content: TextContent, page: PDFPageProxy, colors: { ch: string; color: string }[]): RawLine[] {
  const viewport = page.getViewport({ scale: 1 });
  const items = content.items.filter((i): i is TextItem => 'str' in i);
  let cursor = 0;
  /** The colour of the next letters in the drawing order that match `str`. */
  const colorOf = (str: string) => {
    const first = [...str].find((c) => c.trim());
    if (!first) return null;
    for (let at = cursor; at < Math.min(colors.length, cursor + 400); at++) {
      if (colors[at].ch !== first) continue;
      cursor = at + [...str].filter((c) => c.trim()).length;
      return colors[at].color;
    }
    return null;
  };

  const lines: (RawLine & { end: number; eol: boolean })[] = [];
  for (const item of items) {
    const style = content.styles[item.fontName];
    const t = lib.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(item.transform[2], item.transform[3]) || Math.hypot(item.transform[0], item.transform[1]);
    const x0 = t[4];
    const baseline = t[5];
    const x1 = x0 + item.width;
    const ascent = style?.ascent ?? 0.8;
    const descent = style?.descent ?? -0.2;
    const top = baseline - ascent * size;
    const bottom = baseline - descent * size;
    const color = item.str.trim() ? colorOf(item.str) : null;
    const last = lines.at(-1);
    const sameLine = last && !last.eol && Math.abs(last.baseline - baseline) < size * 0.5 && x0 > last.bbox[0] && x0 - last.end < size * 1.5;
    if (sameLine) {
      last.text += item.str;
      last.bbox = [Math.min(last.bbox[0], x0), Math.min(last.bbox[1], top), Math.max(last.bbox[2], x1), Math.max(last.bbox[3], bottom)];
      last.end = Math.max(last.end, x1);
      last.eol = item.hasEOL;
      // The first span with letters sets the size, font and colour (as PyMuPDF's first span).
      if (!last.fontId && item.str.trim()) Object.assign(last, { size, fontId: item.fontName, color: color ?? last.color });
      continue;
    }
    if (!item.str.trim() && !item.hasEOL) continue;
    lines.push({ text: item.str, bbox: [x0, top, x1, bottom], size, fontId: item.str.trim() ? item.fontName : '', color: color ?? '#000000', baseline, end: x1, eol: item.hasEOL });
  }
  return lines
    .map(({ end: _e, eol: _l, ...line }) => {
      void _e;
      void _l;
      return { ...line, text: line.text.trim() };
    })
    .filter((l) => l.text);
}

/** A page's text lines as the import reads them (no colours), for the PDF export (export.ts). */
export async function readLines(page: PDFPageProxy): Promise<RawLine[]> {
  return rawLines(await pdfjs(), await page.getTextContent(), page, []);
}

/** Left, centre or right, from how the line edges line up within one paragraph. */
function alignOf(lines: RawLine[], pageW: number): Align {
  if (lines.length === 1) {
    const [x0, , x1] = lines[0].bbox;
    return Math.abs((x0 + x1) / 2 - pageW / 2) < pageW * 0.03 ? 'center' : 'left';
  }
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const options: [number, Align][] = [
    [spread(lines.map((l) => l.bbox[0])), 'left'],
    [spread(lines.map((l) => l.bbox[2])), 'right'],
    [spread(lines.map((l) => (l.bbox[0] + l.bbox[2]) / 2)), 'center'],
  ];
  return options.reduce((best, o) => (o[0] < best[0] ? o : best))[1];
}

/** Groups lines into paragraphs: same type size, stacked closely, overlapping sideways. */
function paragraphs(lines: RawLine[]): RawLine[][] {
  const groups: RawLine[][] = [];
  for (const line of lines) {
    const [x0, y0, x1] = line.bbox;
    const last = groups.at(-1)?.at(-1);
    if (last) {
      const [lx0, ly0, lx1, ly1] = last.bbox;
      const sameSize = Math.abs(last.size - line.size) < 0.6;
      const gap = y0 - ly1;
      const close = -(ly1 - ly0) * 0.5 <= gap && gap < (ly1 - ly0) * 1.2;
      const overlap = Math.min(x1, lx1) > Math.max(x0, lx0);
      if (sameSize && close && overlap) {
        groups.at(-1)!.push(line);
        continue;
      }
    }
    groups.push([line]);
  }
  return groups;
}

/** Removes HTML some books have printed as text, even across lines (see import_pdf.py). */
function stripMarkup(lines: RawLine[], removed: string[]): RawLine[] {
  const out: RawLine[] = [];
  let inTag = false;
  let carry = '';
  for (const [i, line] of lines.entries()) {
    let kept = '';
    for (const ch of line.text) {
      if (ch === '<') inTag = true;
      else if (ch === '>' && inTag) inTag = false;
      else if (!inTag) kept += ch;
    }
    let changed = kept.length < line.text.length;
    let text = changed ? kept.split(/\s+/).filter(Boolean).join(' ') : line.text;
    if (carry) {
      text = `${carry} ${text}`.trim();
      carry = '';
      changed = true;
    }
    if (changed && text && text.split(/\s+/).length <= FRAGMENT_WORDS && i !== lines.length - 1) {
      carry = text;
      text = '';
    }
    if (!text) {
      removed.push(line.text);
      continue;
    }
    out.push({ ...line, text, ...(changed ? { source: line.text } : {}) });
  }
  return out;
}

function textLines(raw: RawLine[], pageW: number, pageH: number, fontOf: (id: string) => BookFont | undefined): { lines: TextLine[]; removed: string[] } {
  const removed: string[] = [];
  const kept = stripMarkup(
    raw.filter((l) => {
      if (AD_LINE.test(l.text) && !CREDIT.test(l.text)) {
        removed.push(l.text);
        return false;
      }
      return true;
    }),
    removed
  );
  const lines: TextLine[] = [];
  for (const group of paragraphs(kept)) {
    const align = alignOf(group, pageW);
    for (const line of group) {
      const [x0, y0, x1, y1] = line.bbox;
      lines.push({
        text: line.text,
        x: pct(x0, pageW),
        y: pct(y0, pageH),
        w: pct(x1 - x0, pageW),
        h: pct(y1 - y0, pageH),
        size: pct(line.size, pageW),
        font: fontOf(line.fontId)?.family ?? null,
        color: line.color,
        align,
        ...(line.source ? { source: line.source } : {}),
      });
    }
  }
  return { lines, removed };
}

// ---- art ---------------------------------------------------------------------------------

type ImageObject = { width: number; height: number; bitmap?: ImageBitmap; data?: Uint8ClampedArray | Uint8Array; kind?: number };

const getObject = (page: PDFPageProxy, id: string) =>
  new Promise<ImageObject | null>((resolve) => {
    const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
    const timer = setTimeout(() => resolve(null), 10_000);
    objs.get(id, (data: ImageObject) => {
      clearTimeout(timer);
      resolve(data ?? null);
    });
  });

/** An image object (decoded by pdf.js) drawn on a canvas at its own size, on white. */
function imageCanvas(lib: Pdfjs, img: ImageObject): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, img.width, img.height);
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return canvas;
  }
  const { width, height } = img;
  const rgba = new ImageData(width, height);
  const out = rgba.data;
  const src = img.data!;
  if (img.kind === lib.ImageKind.RGBA_32BPP) out.set(src.subarray(0, width * height * 4));
  else if (img.kind === lib.ImageKind.RGB_24BPP) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = src[j];
      out[i * 4 + 1] = src[j + 1];
      out[i * 4 + 2] = src[j + 2];
      out[i * 4 + 3] = 255;
    }
  } else {
    // 1 bit per pixel, rows padded to whole bytes; 1 = white.
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const at = (y * width + x) * 4;
        out[at] = out[at + 1] = out[at + 2] = v;
        out[at + 3] = 255;
      }
    }
  }
  // putImageData ignores the white underneath; draw through a second canvas so alpha blends on white.
  const tmp = document.createElement('canvas');
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext('2d')!.putImageData(rgba, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  return canvas;
}

/** The page's biggest image and where it sits (page points from the top-left); null if none. */
async function largestImage(lib: Pdfjs, page: PDFPageProxy, ops: { fnArray: number[]; argsArray: unknown[][] }) {
  const { OPS, Util } = lib;
  const viewport = page.getViewport({ scale: 1 });
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  let best: { area: number; rect: [number, number, number, number]; id?: string; inline?: ImageObject } | null = null;
  for (const [i, fn] of ops.fnArray.entries()) {
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args as number[]);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const m = Util.transform(viewport.transform, ctm);
      const xs = [0, 1].flatMap((x) => [0, 1].map((y) => m[0] * x + m[2] * y + m[4]));
      const ys = [0, 1].flatMap((x) => [0, 1].map((y) => m[1] * x + m[3] * y + m[5]));
      const rect: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
      if (!best || area > best.area) best = fn === OPS.paintImageXObject ? { area, rect, id: args[0] as string } : { area, rect, inline: args[0] as ImageObject };
    }
  }
  if (!best) return null;
  const img = best.inline ?? (await getObject(page, best.id!));
  return img ? { img, rect: best.rect } : null;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('A page could not be saved'))), type, quality));

/** Downscaled to at most `max` px wide (or on the long side, `long`). */
function scaled(source: HTMLCanvasElement, max: number, long = false): HTMLCanvasElement {
  const ratio = Math.min(1, max / (long ? Math.max(source.width, source.height) : source.width));
  if (ratio === 1) return source;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * ratio);
  canvas.height = Math.round(source.height * ratio);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The illustration (or, with no image, the whole page at 200 dpi), saved with its thumb. */
async function saveArt(lib: Pdfjs, book: { id: string }, page: PDFPageProxy, index: number, ops: { fnArray: number[]; argsArray: unknown[][] }) {
  const viewport = page.getViewport({ scale: 1 });
  const found = await largestImage(lib, page, ops);
  let canvas: HTMLCanvasElement;
  let rect: [number, number, number, number];
  if (found) {
    canvas = imageCanvas(lib, found.img);
    rect = found.rect;
  } else {
    const view = page.getViewport({ scale: 200 / 72 });
    canvas = document.createElement('canvas');
    canvas.width = Math.round(view.width);
    canvas.height = Math.round(view.height);
    // 'print': pdf.js then draws without waiting for animation frames, which a background tab never gets.
    await page.render({ canvas, viewport: view, intent: 'print' }).promise;
    rect = [0, 0, viewport.width, viewport.height];
  }
  const art = scaled(canvas, ART_MAX, true);
  const name = String(index).padStart(2, '0');
  const image = `pages/${name}.jpg`;
  const thumb = `thumbs/${name}.jpg`;
  await saveFile(localKey(`books/${book.id}/${image}`), await toBlob(art, 'image/jpeg', 0.92));
  await saveFile(localKey(`books/${book.id}/${thumb}`), await toBlob(scaled(art, THUMB_MAX), 'image/jpeg', 0.82));
  const [x0, y0, x1, y1] = rect;
  return {
    image,
    thumb,
    imageWidth: art.width,
    imageHeight: art.height,
    // Clamp: art is often placed a hair past the trim edge.
    imageRect: [Math.max(pct(x0, viewport.width), 0), Math.max(pct(y0, viewport.height), 0), Math.min(pct(x1, viewport.width), 100), Math.min(pct(y1, viewport.height), 100)] as Page['imageRect'],
  };
}

// ---- the book ------------------------------------------------------------------------------

/** Imports `file` into this browser; `onProgress` gets "Page 3 of 14". Returns the new book. */
export async function importPdf(file: File, onProgress?: (message: string) => void): Promise<Book> {
  if (!file.name.toLowerCase().endsWith('.pdf')) throw new Error('Choose a PDF file');
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), fontExtraProperties: true, ...PDFJS_FILES });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch {
    throw new Error('That PDF could not be read');
  }

  const stem = file.name.replace(/\.pdf$/i, '');
  const id = `${slugify(stem)}-${newId('b').slice(-6)}`;
  const fonts: BookFont[] = [];
  const fontIds = new Map<string, BookFont | null>();
  const pages: Page[] = [];
  const firstTexts: string[] = [];

  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress?.(`Page ${i} of ${doc.numPages}…`);
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const ops = (await page.getOperatorList()) as unknown as { fnArray: number[]; argsArray: unknown[][] };
      const content = await page.getTextContent();

      // Every embedded font once, as pdf.js converted it (OpenType), the first time a page uses it.
      for (const fontId of Object.keys(content.styles)) {
        if (fontIds.has(fontId)) continue;
        const font = await new Promise<{ name?: string; data?: Uint8Array; mimetype?: string | null } | null>((resolve) => {
          try {
            page.commonObjs.get(fontId, (f: never) => resolve(f));
          } catch {
            resolve(null);
          }
          setTimeout(() => resolve(null), 5_000);
        });
        if (!font?.data || font.mimetype !== 'font/opentype') {
          fontIds.set(fontId, null);
          continue;
        }
        const pdfName = (font.name ?? fontId).split('+').at(-1)!;
        const n = fonts.length + 1;
        const entry: BookFont = {
          family: `f${n}`,
          file: `fonts/f${n}.otf`,
          pdfName,
          weight: /bold|black|heavy/i.test(pdfName) ? 700 : 400,
          italic: /italic|oblique/i.test(pdfName),
          fallback: fallbackFor(pdfName),
        };
        await saveFile(localKey(`books/${id}/${entry.file}`), new Blob([font.data.slice()], { type: 'font/otf' }));
        fonts.push(entry);
        fontIds.set(fontId, entry);
      }

      const raw = rawLines(lib, content, page, textColors(lib, ops));
      const { lines, removed } = textLines(raw, viewport.width, viewport.height, (fontId) => fontIds.get(fontId) ?? undefined);
      // Ad lines are already dropped, so a story page with an ad footer isn't skipped.
      const joined = lines.map((l) => l.text).join(' ');
      // A back cover repeats an earlier page's blurb.
      const repeat = i === doc.numPages && !!joined.slice(0, 40) && firstTexts.some((t) => t.startsWith(joined.slice(0, 40)));
      firstTexts.push(joined);
      const kind: PageKind = i === 1 ? 'cover' : SKIP_PAGE.test(joined) || repeat ? 'skip' : 'page';

      pages.push({
        index: i,
        kind,
        ...(await saveArt(lib, { id }, page, i, ops)),
        cast: {},
        scenePrompt: '',
        lines,
        ...(removed.length ? { removed } : {}),
      });
      page.cleanup();
    }

    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    const book: Book = {
      id,
      local: true,
      // From the file name, as on the server; PDF metadata titles are often leftovers ("Sibling fight").
      title: titleFrom(stem),
      source: 'source.pdf',
      importedAt: new Date().toISOString(),
      pageWidth: Math.round(first.width * 100) / 100,
      pageHeight: Math.round(first.height * 100) / 100,
      fonts,
      characters: [],
      settings: { artStyle: '', keepOutsideBox: true, textHalo: false },
      pages,
    };
    // The original PDF too: the PDF export builds the finished book from it.
    await saveFile(localKey(`books/${id}/source.pdf`), file);
    await put('books', book);
    emit({ kind: 'books' });
    return book;
  } catch (err) {
    await deleteFiles(localKey(`books/${id}/`));
    throw err;
  } finally {
    await task.destroy();
  }
}
