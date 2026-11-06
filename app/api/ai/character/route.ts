import { drawCharacter } from '@/lib/draw';
import { respond } from '@/lib/http-error';
import { requireBook } from '@/lib/store';
import { fileOf, jpegResponse, specOf } from '@/lib/upload';
import type { PersonFacts } from '@/lib/types';

export const maxDuration = 300;

/** Step 1: one person drawn in the book's style. Multipart: `spec` { bookId, characterId, person } + `photo`. */
export async function POST(req: Request) {
  return respond('ai:character', { status: 500, message: 'Something went wrong — try again' }, async () => {
    const form = await req.formData();
    const { bookId, characterId, person } = specOf<{ bookId: string; characterId: string; person: PersonFacts }>(form);
    const book = await requireBook(bookId);
    return jpegResponse(await drawCharacter(book, characterId, person, await fileOf(form, 'photo', 'The photo')));
  });
}
