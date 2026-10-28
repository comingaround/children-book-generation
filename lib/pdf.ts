import 'server-only';

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { swapName } from './client';
import { HttpError } from './http-error';
import { dataPath, getPerson } from './store';
import { chosenFile, type Book, type Run } from './types';

/**
 * The run as a PDF, made from the book's original PDF by scripts/export_pdf.py: the new art in
 * place of each illustration, the lines whose text changed (names, he/she) rewritten, skipped
 * pages left out.
 * Pages not (yet) made keep the book's own art.
 */
export async function exportPdf(run: Run, book: Book): Promise<Buffer> {
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
    if (file) art[page.index] = dataPath(file);
    const changed = page.lines
      .map((l, i) => ({ text: l.text, newText: run.text?.[page.index]?.[i] ?? names.reduce((t, [from, to]) => swapName(t, from, to), l.text), align: l.align }))
      .filter((l) => l.newText !== l.text);
    if (changed.length) lines[page.index] = changed;
  }

  const out = dataPath('runs', run.id, 'book.pdf');
  const spec = { source: dataPath('books', book.id, book.source), out, keep: keep.map((p) => p.index), art, lines };
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
