import { rewriteText } from '@/lib/draw';
import { respond } from '@/lib/http-error';
import { bookFrom } from '@/lib/book-input';
import type { TextCast } from '@/lib/text';
import type { Book } from '@/lib/types';

export const maxDuration = 120;

/** The he/she rewrite of a book's text for a run's people: `{ bookId or book, cast }` in, `{ text }` out. */
export async function POST(req: Request) {
  return respond('ai:text', { status: 500, message: 'The text rewrite failed' }, async () => {
    const spec = (await req.json()) as { bookId?: string; book?: Book; cast: TextCast[] };
    const { book } = await bookFrom(spec);
    return Response.json({ text: await rewriteText(book, spec.cast ?? []) });
  });
}
