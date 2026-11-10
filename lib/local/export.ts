import fontkit from '@pdf-lib/fontkit';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from '@cantoo/pdf-lib';

import { swapNames } from '../text';
import { bookFile, chosenFile, fileUrl, type Book, type Page, type Run } from '../types';
import { readFile } from './files';
import { pdfjs, PDFJS_FILES, readLines, type RawLine } from './import';

/**
 * The finished book as a PDF, made in the browser from the book's original PDF, as
 * scripts/export_pdf.py does on the server: each page's illustration (its largest image) swapped
 * for the new art, only the lines whose text changed (names, he/she, cleaned at import) removed
 * and set again in the book's font, size and colour, ads and markup removed, skipped pages left
 * out. Pages not (yet) made keep the book's own art. `print`: 300 dpi art and 3 mm bleed.
 */

/** 3 mm, the usual bleed, in PDF points. */
const BLEED_PT = (3 / 25.4) * 72;
const PRINT_DPI = 300;
/** The bleed and the page's outer EDGE points are filled from a STRIP just inside (see export_pdf.py). */
const EDGE = 3;
const STRIP = 1;
/**
 * pdf-lib loads and saves in slices with a timer between them; a background tab gets those
 * timers once a second at best, so a book took minutes. Done in one go it takes a second.
 */
const UNTHROTTLED = Infinity;

const fetchBytes = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error('A file of the book could not be loaded');
  return new Uint8Array(await res.arrayBuffer());
};

/** A file of the book, from this browser (imported books) or the server (published ones). */
const bookBytes = (book: Book, path: string) => (book.local ? readFile(bookFile(book, path)).then(async (b) => new Uint8Array(await b.arrayBuffer())) : fetchBytes(fileUrl(bookFile(book, path))));

// ---- content streams --------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

/** One operator with its operands, and where it sits in the stream (for cutting it out). */
interface Op {
  op: string;
  args: (number | string)[];
  start: number;
  end: number;
}

/**
 * A PDF content stream read as operators. Only numbers are kept as operand values; strings,
 * arrays and dictionaries are skipped over as whole (this export only needs positions).
 */
function parseOps(s: string): Op[] {
  const ops: Op[] = [];
  let args: (number | string)[] = [];
  let start = -1;
  let i = 0;
  const skipString = () => {
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return void i++;
    }
  };
  /** Skips a balanced [ ... ] or << ... >>, minding strings inside. */
  const skipGroup = (open: string, close: string) => {
    let depth = 0;
    while (i < s.length) {
      if (s[i] === '(') skipString();
      else if (s.startsWith(open, i)) {
        depth++;
        i += open.length;
      } else if (s.startsWith(close, i)) {
        i += close.length;
        if (--depth === 0) return;
      } else i++;
    }
  };
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (WHITE.has(code)) {
      i++;
      continue;
    }
    if (start < 0) start = i;
    const c = s[i];
    if (c === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
      if (!args.length) start = -1;
    } else if (c === '(') {
      skipString();
      args.push('string');
    } else if (s.startsWith('<<', i)) {
      skipGroup('<<', '>>');
      args.push('dict');
    } else if (c === '<') {
      i = s.indexOf('>', i) + 1 || s.length;
      args.push('string');
    } else if (c === '[') {
      skipGroup('[', ']');
      args.push('array');
    } else if (c === '/') {
      i++;
      while (i < s.length && !WHITE.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
      args.push('name');
    } else {
      const from = i;
      while (i < s.length && !WHITE.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
      if (i === from) i++;
      const word = s.slice(from, i);
      const n = Number(word);
      if (word !== '' && !Number.isNaN(n)) {
        args.push(n);
        continue;
      }
      if (word === 'BI') {
        // An inline image: its data runs to EI and may hold any bytes.
        const data = s.indexOf('ID', i);
        let ei = data + 2;
        while (ei < s.length && !(WHITE.has(s.charCodeAt(ei - 1)) && s.startsWith('EI', ei) && (ei + 2 >= s.length || WHITE.has(s.charCodeAt(ei + 2))))) ei++;
        i = Math.min(ei + 2, s.length);
        ops.push({ op: 'BI', args: [], start, end: i });
      } else {
        ops.push({ op: word, args, start, end: i });
      }
      args = [];
      start = -1;
    }
  }
  return ops;
}

/**
 * Where each text-showing operator starts drawing, in page points from the top-left: the text
 * matrix and the transformation matrix applied to the origin. Text after the first show on a line
 * keeps the line's start, which lies inside the same line either way.
 */
function showPositions(ops: Op[], mediaBox: number[]): Map<Op, [number, number]> {
  const out = new Map<Op, [number, number]>();
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let tm: Matrix = [1, 0, 0, 1, 0, 0];
  let tlm: Matrix = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  const num = (op: Op, k: number) => (typeof op.args[k] === 'number' ? (op.args[k] as number) : 0);
  const nextLine = (tx: number, ty: number) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  for (const op of ops) {
    switch (op.op) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? ctm;
        break;
      case 'cm':
        ctm = multiply([0, 1, 2, 3, 4, 5].map((k) => num(op, k)) as Matrix, ctm);
        break;
      case 'BT':
        tm = tlm = [1, 0, 0, 1, 0, 0];
        break;
      case 'Tm':
        tm = tlm = [0, 1, 2, 3, 4, 5].map((k) => num(op, k)) as Matrix;
        break;
      case 'Td':
        nextLine(num(op, 0), num(op, 1));
        break;
      case 'TD':
        leading = -num(op, 1);
        nextLine(num(op, 0), num(op, 1));
        break;
      case 'TL':
        leading = num(op, 0);
        break;
      case 'T*':
        nextLine(0, -leading);
        break;
      case "'":
      case '"':
        nextLine(0, -leading);
      // falls through
      case 'Tj':
      case 'TJ': {
        const m = multiply(tm, ctm);
        out.set(op, [m[4] - mediaBox[0], mediaBox[3] - m[5]]);
        break;
      }
    }
  }
  return out;
}

/**
 * Cuts the text of `targets` (line boxes, points from the top-left) out of the page's content,
 * keeping everything else byte for byte. What the line showed is gone; its place stays put.
 */
function removeText(doc: PDFDocument, page: PDFPage, targets: RawLine[]): void {
  if (!targets.length) return;
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  const decoder = new TextDecoder('latin1');
  const source = streams
    .map((st) => (st instanceof PDFRawStream ? decoder.decode(decodePDFRawStream(st).decode()) : ''))
    .join('\n');
  const ops = parseOps(source);
  const box = page.getMediaBox();
  const positions = showPositions(ops, [box.x, box.y, box.x + box.width, box.y + box.height]);
  const hit = (op: Op) => {
    const at = positions.get(op);
    return !!at && targets.some(({ bbox: [x0, y0, x1, y1] }) => at[0] >= x0 - 2 && at[0] <= x1 && at[1] >= y0 && at[1] <= y1 + 1);
  };
  let out = '';
  let from = 0;
  for (const op of ops) {
    if (!positions.has(op) || !hit(op)) continue;
    // A ' or " also moves to the next line; keep that move.
    const keep = op.op === "'" ? ' T*' : op.op === '"' ? ` ${op.args[0]} Tw ${op.args[1]} Tc T*` : '';
    out += source.slice(from, op.start) + keep;
    from = op.end;
  }
  out += source.slice(from);
  const bytes = Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
  // Wrapped in q … Q, so what is drawn after (the new text) starts from a clean state.
  const wrapped = new Uint8Array([...'q\n'].map((c) => c.charCodeAt(0)).concat([...bytes], [...'\nQ\n'].map((c) => c.charCodeAt(0))));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(wrapped)));
}

// ---- art ----------------------------------------------------------------------------------

/** The page's largest image (by pixels), looking into forms too: where it is named and its ref. */
function largestImage(doc: PDFDocument, resources: PDFDict | undefined, seen = new Set<PDFDict>()): { xobjects: PDFDict; name: PDFName; ref: PDFRef; pixels: number } | null {
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects || seen.has(xobjects)) return null;
  seen.add(xobjects);
  let best: ReturnType<typeof largestImage> = null;
  for (const [name, value] of xobjects.entries()) {
    if (!(value instanceof PDFRef)) continue;
    const stream = doc.context.lookup(value);
    if (!(stream instanceof PDFRawStream)) continue;
    const subtype = stream.dict.get(PDFName.of('Subtype'));
    if (subtype === PDFName.of('Image')) {
      const w = stream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() ?? 0;
      const h = stream.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber() ?? 0;
      if (!best || w * h > best.pixels) best = { xobjects, name, ref: value, pixels: w * h };
    } else if (subtype === PDFName.of('Form')) {
      const inner = largestImage(doc, stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), seen);
      if (inner && (!best || inner.pixels > best.pixels)) best = inner;
    }
  }
  return best;
}

/** The art as JPEG; for print, resampled to 300 dpi at the size it is printed. */
async function artBytes(blob: Blob, book: Book, page: Page, print: boolean): Promise<Uint8Array> {
  const [x0, , x1] = page.imageRect;
  const width = Math.ceil((((x1 - x0) / 100) * book.pageWidth) / 72 * PRINT_DPI);
  const bitmap = print ? await createImageBitmap(blob) : null;
  if (!bitmap || bitmap.width >= width) {
    bitmap?.close();
    return new Uint8Array(await blob.arrayBuffer());
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round((bitmap.height / bitmap.width) * width);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const big = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('A page could not be made'))), 'image/jpeg', 0.92));
  return new Uint8Array(await big.arrayBuffer());
}

// ---- text ---------------------------------------------------------------------------------

/** A font that can set text here, with a check that a letter has a real shape in it. */
interface Face {
  pdf: PDFFont;
  has: (ch: string) => boolean;
}

/**
 * A font file made usable, or null if fontkit can't read it. Embedded whole: these are already
 * the subsets the book's PDF carried, and fontkit's subsetter never finished on some (Trick Trike).
 * A subset keeps every letter in its map but only the outlines its pages used, so a letter counts
 * only if its glyph has an outline.
 */
async function makeFace(doc: PDFDocument, bytes: Uint8Array): Promise<Face | null> {
  try {
    const font = fontkit.create(bytes as unknown as Buffer) as unknown as {
      hasGlyphForCodePoint: (c: number) => boolean;
      glyphForCodePoint: (c: number) => { id: number; path: { commands: unknown[] } };
      italicAngle: number;
      ascent: number;
      descent: number;
      capHeight: number;
      xHeight: number;
      bbox: { minX: number };
    };
    // What pdf-lib reads when it writes the font at save; subsets lacking a table (post, OS/2) fail here.
    void [font.italicAngle, font.ascent, font.descent, font.capHeight, font.xHeight, font.bbox.minX];
    const pdf = await doc.embedFont(bytes, { subset: false });
    const has = (ch: string) => {
      try {
        const code = ch.codePointAt(0)!;
        if (!font.hasGlyphForCodePoint(code)) return false;
        if (!ch.trim()) return true;
        const glyph = font.glyphForCodePoint(code);
        return glyph.id !== 0 && glyph.path.commands.length > 0;
      } catch {
        return false;
      }
    };
    // Some fonts pulled out of PDFs parse but break on use; find out now, not halfway through a page.
    pdf.widthOfTextAtSize('Aa', 10);
    pdf.encodeText('Aa');
    if (!has('a') && !has('A')) return null;
    return { pdf, has };
  } catch {
    return null;
  }
}

/** The font file of the font named `pdfName` that this page itself uses (as export_pdf.py takes it). */
function pageFontFile(doc: PDFDocument, page: PDFPage, pdfName: string): { key: string; bytes: Uint8Array } | null {
  const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  for (const [, value] of fonts?.entries() ?? []) {
    const font = doc.context.lookup(value);
    if (!(font instanceof PDFDict)) continue;
    const name = font.get(PDFName.of('BaseFont'))?.toString().replace(/^\//, '').split('+').at(-1) ?? '';
    if (!name || !(name.startsWith(pdfName) || pdfName.startsWith(name))) continue;
    const descendant = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookup(0);
    const descriptor = (descendant instanceof PDFDict ? descendant : font).lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
      const ref = descriptor?.get(PDFName.of(key));
      const stream = ref && doc.context.lookup(ref);
      if (stream instanceof PDFRawStream) return { key: ref!.toString(), bytes: decodePDFRawStream(stream).decode() };
    }
  }
  return null;
}

/** Splits text into runs: the first face with the letter's shape, else the fallback. */
function runsOf(text: string, faces: Face[], fallback: Face): [Face, string][] {
  const out: [Face, string][] = [];
  for (const ch of text) {
    const use = faces.find((f) => f.has(ch)) ?? fallback;
    const last = out.at(-1);
    if (last && last[0] === use) last[1] += ch;
    else out.push([use, ch]);
  }
  return out;
}

/** Characters Helvetica (WinAnsi) can't set become their closest plain letter, else '?'. */
const winAnsi = (ch: string) => {
  const plain = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return /^[\x20-\x7e\xa0-\xff‘’“”–—…]$/.test(ch) ? ch : /^[\x20-\x7e]+$/.test(plain) ? plain : '?';
};

// ---- the book --------------------------------------------------------------------------------

/** Makes the PDF and returns it; the caller saves it. */
export async function exportPdfInBrowser(book: Book, run: Run, names: [string, string][], print: boolean): Promise<Blob> {
  const sourceBytes = await bookBytes(book, book.source);
  // Many books carry an owner password (no open password): load them decrypted, as readers do.
  const doc = await PDFDocument.load(sourceBytes, { password: '', parseSpeed: UNTHROTTLED });
  doc.registerFontkit(fontkit);
  const lib = await pdfjs();
  const task = lib.getDocument({ data: sourceBytes.slice(), ...PDFJS_FILES });
  const reader = await task.promise;

  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const fallback: Face = { pdf: helvetica, has: () => true };
  const faces = new Map<string, Face | null>();
  /** A font file embedded once, by a key naming where it came from. */
  const faceFor = async (key: string, load: () => Promise<Uint8Array | null>) => {
    if (!faces.has(key)) faces.set(key, await load().then((bytes) => (bytes ? makeFace(doc, bytes) : null)).catch(() => null));
    return faces.get(key) ?? null;
  };
  /**
   * The fonts a line is set in, best first: the subset its own page uses, then the book's other
   * subsets of that font (each carries only some letters); Helvetica is the last resort.
   */
  const facesFor = async (page: PDFPage, family: string | null): Promise<Face[]> => {
    const font = book.fonts.find((f) => f.family === family);
    if (!font) return [];
    const own = pageFontFile(doc, page, font.pdfName);
    const list = [own && (await faceFor(own.key, async () => own.bytes))];
    for (const f of book.fonts.filter((x) => x.pdfName === font.pdfName)) list.push(await faceFor(f.file, () => bookBytes(book, f.file)));
    return list.filter((f): f is Face => !!f);
  };

  const keep = book.pages.filter((p) => p.kind !== 'skip');
  const pages = doc.getPages();
  try {
    for (const page of keep) {
      const target = pages[page.index - 1];
      if (!target) continue;

      // The lines whose text changes, and ad or markup lines to remove, found where the PDF has them.
      const changes = page.lines
        .map((l, i) => ({ text: l.source ?? l.text, newText: run.text?.[page.index]?.[i] ?? swapNames(l.text, names), line: l }))
        .filter((c) => c.newText !== c.text);
      const removed = page.removed ?? [];
      const found = changes.length || removed.length ? await readLines(await reader.getPage(page.index)) : [];
      const located = changes.map((c) => ({ ...c, at: found.find((f) => f.text === c.text) })).filter((c) => c.at);
      removeText(doc, target, [...located.map((c) => c.at!), ...found.filter((f) => removed.includes(f.text))]);

      // The new art in place of the illustration (or over the whole page if it had no image).
      const step = run.pages[page.index];
      const file = step && chosenFile(step);
      if (file) {
        const image = await doc.embedJpg(await artBytes(await readFile(file), book, page, print));
        const art = largestImage(doc, target.node.Resources());
        if (art) art.xobjects.set(art.name, image.ref);
        else target.drawImage(image, { x: 0, y: 0, width: target.getWidth(), height: target.getHeight() });
      }

      // The changed lines, in the book's font where it has the letters, at their own baseline.
      const height = target.getHeight();
      for (const { newText, line, at } of located) {
        if (!newText.trim()) continue;
        const [x0, , x1] = at!.bbox;
        const runs = runsOf(newText, await facesFor(target, line.font), fallback).map(([face, part]) => [face, face === fallback ? [...part].map(winAnsi).join('') : part] as [Face, string]);
        let size = at!.size;
        let width = runs.reduce((w, [face, part]) => w + face.pdf.widthOfTextAtSize(part, size), 0);
        if (width > x1 - x0 && newText.length > (line.source ?? line.text).length) {
          size *= (x1 - x0) / width;
          width = x1 - x0;
        }
        let x = line.align === 'center' ? (x0 + x1 - width) / 2 : line.align === 'right' ? x1 - width : x0;
        const hex = line.color.replace('#', '');
        const color = rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
        for (const [face, part] of runs) {
          target.drawText(part, { x, y: height - at!.baseline, size, font: face.pdf, color });
          x += face.pdf.widthOfTextAtSize(part, size);
        }
      }
    }
  } finally {
    await task.destroy();
  }

  for (let i = pages.length - 1; i >= 0; i--) if (!keep.some((p) => p.index === i + 1)) doc.removePage(i);
  if (print) await addBleed(doc);
  const bytes = await doc.save({ objectsPerTick: UNTHROTTLED });
  return new Blob([bytes.slice()], { type: 'application/pdf' });
}

/**
 * Turns every page into a sheet BLEED_PT larger per side with its edges extended, in the same
 * document (so images and fonts are shared, not copied): each page is embedded once and drawn at
 * the centre, and the bleed bands draw thin strips of it, stretched. The original pages go.
 */
async function addBleed(doc: PDFDocument): Promise<void> {
  // Writes the new images and fonts into the document, so the embedded pages include them.
  await doc.flush();
  const b = BLEED_PT;
  const originals = doc.getPages();
  for (const page of originals) {
    const w = page.getWidth();
    const h = page.getHeight();
    const W = w + 2 * b;
    const H = h + 2 * b;
    const sheet = doc.addPage([W, H]);
    const embedded = await doc.embedPage(page);
    sheet.drawPage(embedded, { x: b, y: b, width: w, height: h });
    const name = sheet.node.newXObject('Bleed', embedded.ref);
    const e = b + EDGE;
    const a = EDGE;
    const s = EDGE + STRIP;
    // (target on the sheet, source strip on the page), both [x0, y0, x1, y1] from the top-left.
    const bands: [number[], number[]][] = [
      [[0, e, e, H - e], [a, a, s, h - a]],
      [[W - e, e, W, H - e], [w - s, a, w - a, h - a]],
      [[e, 0, W - e, e], [a, a, w - a, s]],
      [[e, H - e, W - e, H], [a, h - s, w - a, h - a]],
      [[0, 0, e, e], [a, a, s, s]],
      [[W - e, 0, W, e], [w - s, a, w - a, s]],
      [[0, H - e, e, H], [a, h - s, s, h - a]],
      [[W - e, H - e, W, H], [w - s, h - s, w - a, h - a]],
    ];
    for (const [[tx0, ty0, tx1, ty1], [cx0, cy0, cx1, cy1]] of bands) {
      // In PDF space (from the bottom-left): stretch the strip onto the band, clipped to the band.
      const sx = (tx1 - tx0) / (cx1 - cx0);
      const sy = (ty1 - ty0) / (cy1 - cy0);
      const tx = tx0 - cx0 * sx;
      const ty = H - ty1 - (h - cy1) * sy;
      sheet.pushOperators(
        pushGraphicsState(),
        rectangle(tx0, H - ty1, tx1 - tx0, ty1 - ty0),
        clip(),
        endPath(),
        concatTransformationMatrix(sx, 0, 0, sy, tx, ty),
        drawObject(name),
        popGraphicsState()
      );
    }
    sheet.setBleedBox(0, 0, W, H);
    sheet.setTrimBox(b, b, w, h);
  }
  for (let i = originals.length - 1; i >= 0; i--) doc.removePage(i);
}
