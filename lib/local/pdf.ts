import { apiBlob } from '../client';
import { chosenFile, type Book, type Run } from '../types';
import { readFile } from './files';

/**
 * Sends the run's art (the version each page shows) to app/api/pdf and saves the PDF it makes.
 * `names`: the name swaps the pages show. `print`: 300 dpi art and 3 mm bleed, for a printer.
 */
export async function downloadPdf(book: Book, run: Run, names: [string, string][], print: boolean): Promise<void> {
  const form = new FormData();
  const pages: number[] = [];
  for (const index of run.pageIndexes) {
    const file = run.pages[index] && chosenFile(run.pages[index]);
    if (!file) continue;
    form.set(`art-${index}`, await readFile(file));
    pages.push(index);
  }
  form.set('spec', JSON.stringify({ bookId: book.id, pages, names, text: run.text, print }));
  const pdf = await apiBlob('/api/pdf', { method: 'POST', body: form });

  const url = URL.createObjectURL(pdf);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${book.title.replace(/[^\w\- ]+/g, '').trim() || 'book'}${print ? ' (print)' : ''}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
