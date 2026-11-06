import { rewriteText } from '@/lib/draw';
import { respond } from '@/lib/http-error';
import { requireBook } from '@/lib/store';
import type { TextCast } from '@/lib/text';

export const maxDuration = 120;

/** The he/she rewrite of a book's text for a run's people: `{ bookId, cast }` in, `{ text }` out. */
export async function POST(req: Request) {
  return respond('ai:text', { status: 500, message: 'The text rewrite failed' }, async () => {
    const { bookId, cast } = (await req.json()) as { bookId: string; cast: TextCast[] };
    const book = await requireBook(bookId);
    return Response.json({ text: await rewriteText(book, cast ?? []) });
  });
}
