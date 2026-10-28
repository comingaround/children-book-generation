import { respond } from '@/lib/http-error';
import { exportPdf } from '@/lib/pdf';
import { requireBook, requireRun } from '@/lib/store';

/** The run as a PDF download (see lib/pdf.ts); `?print=1` for the printer's version. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond('run:pdf', { status: 500, message: 'Could not make the PDF' }, async () => {
    const run = await requireRun((await params).id);
    const book = await requireBook(run.bookId);
    const print = new URL(req.url).searchParams.has('print');
    const pdf = await exportPdf(run, book, print);
    const name = `${book.title.replace(/[^\w\- ]+/g, '').trim() || 'book'}${print ? ' (print)' : ''}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"` },
    });
  });
}
