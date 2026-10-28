import { respond } from '@/lib/http-error';
import { exportPdf } from '@/lib/pdf';
import { requireBook, requireRun } from '@/lib/store';

/** The run as a PDF download (see lib/pdf.ts). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond('run:pdf', { status: 500, message: 'Could not make the PDF' }, async () => {
    const run = await requireRun((await params).id);
    const book = await requireBook(run.bookId);
    const pdf = await exportPdf(run, book);
    const name = `${book.title.replace(/[^\w\- ]+/g, '').trim() || 'book'}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"` },
    });
  });
}
