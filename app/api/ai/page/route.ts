import { drawPageStep, type PageMember } from '@/lib/draw';
import { spendImage } from '@/lib/guard';
import { respond } from '@/lib/http-error';
import { bookFrom } from '@/lib/book-input';
import { fileOf, jpegResponse, specOf } from '@/lib/upload';
import type { Book, PersonFacts } from '@/lib/types';

export const maxDuration = 300;

interface Spec {
  bookId?: string;
  book?: Book;
  index: number;
  members: { characterId: string; person: PersonFacts }[];
  fix: string | null;
  fixFor: string | null;
}

/**
 * Step 2: one image call on a page (see drawPageStep). Multipart: `spec`, `photo-<n>` and
 * `drawing-<n>` per member, and `art` once a character before them has been drawn on it.
 */
export async function POST(req: Request) {
  return respond('ai:page', { status: 500, message: 'Something went wrong — try again' }, async () => {
    spendImage(req);
    const form = await req.formData();
    const spec = specOf<Spec>(form);
    const input = await bookFrom(spec, form);
    const members: PageMember[] = [];
    for (const [n, m] of (spec.members ?? []).entries()) {
      members.push({ ...m, photo: await fileOf(form, `photo-${n}`, `${m.person.name}'s photo`), drawing: await fileOf(form, `drawing-${n}`, `${m.person.name}'s drawing`) });
    }
    const art = form.has('art') ? await fileOf(form, 'art', 'The page') : null;
    return jpegResponse(await drawPageStep(input, Number(spec.index), art, members, spec.fix?.trim() || null, spec.fixFor ?? null));
  });
}
