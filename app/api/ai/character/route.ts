import { drawCharacter } from '@/lib/draw';
import { spendImage } from '@/lib/guard';
import { respond } from '@/lib/http-error';
import { bookFrom } from '@/lib/book-input';
import { fileOf, jpegResponse, specOf } from '@/lib/upload';
import type { Book, PersonFacts } from '@/lib/types';

export const maxDuration = 300;

/**
 * Step 1: one person drawn in the book's style. Multipart: `spec` { bookId or book, characterId,
 * person } + `photo` (+ the book's art for a browser book, see lib/book-input.ts).
 */
export async function POST(req: Request) {
  return respond('ai:character', { status: 500, message: 'Something went wrong — try again' }, async () => {
    spendImage(req);
    const form = await req.formData();
    const spec = specOf<{ bookId?: string; book?: Book; characterId: string; person: PersonFacts }>(form);
    const input = await bookFrom(spec, form);
    return jpegResponse(await drawCharacter(input, spec.characterId, spec.person, await fileOf(form, 'photo', 'The photo')));
  });
}
