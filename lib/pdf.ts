import 'server-only';

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { swapName } from './client';
import { HttpError } from './http-error';
import { upscaleTo } from './images';
import { dataPath, getPerson, readDataFile, writeFileIn } from './store';
import { chosenFile, type Book, type Run } from './types';

/** 3 mm, the usual bleed, in PDF points. */
const BLEED_PT = (3 / 25.4) * 72;
const PRINT_DPI = 300;

/** The art resampled to PRINT_DPI at the size it is printed (the page's image box), or as is. */
async function forPrint(run: Run, book: Book, [x0, , x1]: number[], file: string): Promise<string> {
  const inches = (((x1 - x0) / 100) * book.pageWidth) / 72;
  const big = await upscaleTo(await readDataFile(file), Math.ceil(inches * PRINT_DPI));
  return big ? writeFileIn(`runs/${run.id}/print/${file.split('/').pop()!.replace(/\.\w+$/, '.jpg')}`, big) : file;
}

/**
 * The run as a PDF, made from the book's original PDF by scripts/export_pdf.py: the new art in
 * place of each illustration, the lines whose text changed (names, he/she) rewritten, skipped
 * pages left out.
 * Pages not (yet) made keep the book's own art.
 *
 * `print`: for a printer. The new art is resampled to 300 dpi at its printed size (sharper
 * edges, no new detail) and every page gets 3 mm of bleed, with the trim box set to the page.
 */
export async function exportPdf(run: Run, book: Book, print = false): Promise<Buffer> {
  const names: [string, string][] = [];
  for (const step of run.cast) {
    const from = book.characters.find((c) => c.id === step.characterId)?.nameInText.trim();
    const to = (await getPerson(step.personId))?.name;
    if (from && to) names.push([from, to]);
  }

  const keep = book.pages.filter((p) => p.kind !== 'skip');
  const art: Record<string, string> = {};
  const lines: Record<string, { text: string; newText: string; align: string }[]> = {};
  for (const page of keep) {
    const step = run.pages[page.index];
    const file = step && chosenFile(step);
    if (file) art[page.index] = dataPath(print ? await forPrint(run, book, page.imageRect, file) : file);
    const changed = page.lines
      .map((l, i) => ({ text: l.text, newText: run.text?.[page.index]?.[i] ?? names.reduce((t, [from, to]) => swapName(t, from, to), l.text), align: l.align }))
      .filter((l) => l.newText !== l.text);
    if (changed.length) lines[page.index] = changed;
  }

  const out = dataPath('runs', run.id, print ? 'book-print.pdf' : 'book.pdf');
  const spec = { source: dataPath('books', book.id, book.source), out, keep: keep.map((p) => p.index), art, lines, bleed: print ? BLEED_PT : 0 };
  await new Promise<void>((resolve, reject) => {
    const child = execFile('python', ['-I', join(process.cwd(), 'scripts', 'export_pdf.py')], { timeout: 300_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const reason = String(stderr).match(/EXPORT_ERROR: (.*)/)?.[1];
      reject(new HttpError(500, reason ? `PDF export failed: ${reason}` : 'PDF export failed — is Python with PyMuPDF installed?', String(stderr) || String(err)));
    });
    child.stdin?.end(JSON.stringify(spec));
  });
  return readFile(out);
}
