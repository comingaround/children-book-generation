import { respond } from '@/lib/http-error';
import { localOnly } from '@/lib/hosted';
import { exportPdf } from '@/lib/pdf';
import { requireBook } from '@/lib/store';
import { fileOf, specOf } from '@/lib/upload';

export const maxDuration = 300;

interface Spec {
  bookId: string;
  /** Pages with new art; each comes as the file `art-<index>`. */
  pages: number[];
  names: [string, string][];
  text?: Record<string, string[]>;
  print?: boolean;
}

/** A run as a PDF download (see lib/pdf.ts). Multipart, since the run's art lives in the browser. */
export async function POST(req: Request) {
  return respond('pdf', { status: 500, message: 'Could not make the PDF' }, async () => {
    localOnly();
    const form = await req.formData();
    const spec = specOf<Spec>(form);
    const book = await requireBook(spec.bookId);
    const art: Record<string, Buffer> = {};
    for (const index of spec.pages ?? []) art[index] = await fileOf(form, `art-${index}`, `Page ${index}`);
    const pdf = await exportPdf(book, { art, names: spec.names ?? [], text: spec.text }, !!spec.print);
    const name = `${book.title.replace(/[^\w\- ]+/g, '').trim() || 'book'}${spec.print ? ' (print)' : ''}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"` },
    });
  });
}
