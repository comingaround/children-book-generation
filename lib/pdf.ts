import 'server-only';

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HttpError } from './http-error';
import { upscaleTo } from './images';
import { dataPath } from './store';
import { swapNames } from './text';
import type { Book } from './types';

/** 3 mm, the usual bleed, in PDF points. */
const BLEED_PT = (3 / 25.4) * 72;
const PRINT_DPI = 300;

/** What a run adds to the book; the browser sends it, since runs live there. */
export interface PdfRun {
  /** New art by page index (the version each page shows). */
  art: Record<string, Buffer>;
  /** Name swaps: [name in the book, person's name]. */
  names: [string, string][];
  /** The run's he/she rewrite, by page index (see Run.text). */
  text?: Record<string, string[]>;
}

/** The art resampled to PRINT_DPI at the size it is printed (the page's image box), or as is. */
async function forPrint(book: Book, [x0, , x1]: number[], art: Buffer): Promise<Buffer> {
  const inches = (((x1 - x0) / 100) * book.pageWidth) / 72;
  return (await upscaleTo(art, Math.ceil(inches * PRINT_DPI))) ?? art;
}

/**
 * The run as a PDF, made from the book's original PDF by scripts/export_pdf.py: the new art in
 * place of each illustration, the lines whose text changed (names, he/she, cleaned at import)
 * rewritten, ads and markup the import left out removed, skipped pages left out.
 * Pages not (yet) made keep the book's own art. Works in a scratch folder, removed afterwards.
 *
 * `print`: for a printer. The new art is resampled to 300 dpi at its printed size (sharper
 * edges, no new detail) and every page gets 3 mm of bleed, with the trim box set to the page.
 */
export async function exportPdf(book: Book, run: PdfRun, print = false): Promise<Buffer> {
  const dir = dataPath('uploads', `pdf-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  try {
    const keep = book.pages.filter((p) => p.kind !== 'skip');
    const art: Record<string, string> = {};
    const lines: Record<string, { text: string; newText: string; align: string }[]> = {};
    for (const page of keep) {
      const given = run.art[page.index];
      if (given) {
        art[page.index] = join(dir, `page-${page.index}.jpg`);
        await writeFile(art[page.index], print ? await forPrint(book, page.imageRect, given) : given);
      }
      const changed = page.lines
        .map((l, i) => ({ text: l.source ?? l.text, newText: run.text?.[page.index]?.[i] ?? swapNames(l.text, run.names), align: l.align }))
        .filter((l) => l.newText !== l.text)
        .concat((page.removed ?? []).map((text) => ({ text, newText: '', align: 'left' as const })));
      if (changed.length) lines[page.index] = changed;
    }

    const out = join(dir, 'book.pdf');
    const spec = { source: dataPath('books', book.id, book.source), out, keep: keep.map((p) => p.index), art, lines, bleed: print ? BLEED_PT : 0 };
    await new Promise<void>((resolve, reject) => {
      const child = execFile('python', ['-I', join(process.cwd(), 'scripts', 'export_pdf.py')], { timeout: 300_000 }, (err, _stdout, stderr) => {
        if (!err) return resolve();
        const reason = String(stderr).match(/EXPORT_ERROR: (.*)/)?.[1];
        reject(new HttpError(500, reason ? `PDF export failed: ${reason}` : 'PDF export failed — is Python with PyMuPDF installed?', String(stderr) || String(err)));
      });
      child.stdin?.end(JSON.stringify(spec));
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
