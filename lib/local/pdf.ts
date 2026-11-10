import { apiBlob } from '../client';
import { chosenFile, type Book, type Run } from '../types';
import { exportPdfInBrowser } from './export';
import { readFile } from './files';

/**
 * Makes the run's PDF and saves it. `names`: the name swaps the pages show. `print`: 300 dpi art
 * and 3 mm bleed, for a printer. A published book on the local version goes to app/api/pdf
 * (scripts/export_pdf.py, with system fonts for letters a book's font lacks); everywhere else the
 * browser makes it (export.ts).
 */
export async function downloadPdf(book: Book, run: Run, names: [string, string][], print: boolean, onServer: boolean): Promise<void> {
  save(onServer && !book.local ? await serverPdf(book, run, names, print) : await exportPdfInBrowser(book, run, names, print), book, print);
}

async function serverPdf(book: Book, run: Run, names: [string, string][], print: boolean): Promise<Blob> {
  const form = new FormData();
  const pages: number[] = [];
  for (const index of run.pageIndexes) {
    const file = run.pages[index] && chosenFile(run.pages[index]);
    if (!file) continue;
    form.set(`art-${index}`, await readFile(file));
    pages.push(index);
  }
  form.set('spec', JSON.stringify({ bookId: book.id, pages, names, text: run.text, print }));
  return apiBlob('/api/pdf', { method: 'POST', body: form });
}

function save(pdf: Blob, book: Book, print: boolean): void {
  const url = URL.createObjectURL(pdf);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${book.title.replace(/[^\w\- ]+/g, '').trim() || 'book'}${print ? ' (print)' : ''}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
