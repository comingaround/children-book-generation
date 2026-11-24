import { bookFrom } from '@/lib/book-input';
import { refadePageStep } from '@/lib/draw';
import { spendImage } from '@/lib/guard';
import { localOnly } from '@/lib/hosted';
import { respond } from '@/lib/http-error';
import type { Book } from '@/lib/types';
import { fileOf, jpegResponse, specOf } from '@/lib/upload';

export const maxDuration = 300;

interface Spec {
  bookId?: string;
  book?: Book;
  index: number;
  characterIds: string[];
}

/** "Match the fade" (see refadePageStep). Multipart: `spec`, `current` and `drawing-<n>` per character. Local only. */
export async function POST(req: Request) {
  return respond('ai:refade', { status: 500, message: 'Something went wrong — try again' }, async () => {
    localOnly();
    spendImage(req);
    const form = await req.formData();
    const spec = specOf<Spec>(form);
    const input = await bookFrom(spec, form);
    const current = await fileOf(form, 'current', 'The version to fade');
    const drawings = [];
    for (const [n, characterId] of (spec.characterIds ?? []).entries()) drawings.push({ characterId, drawing: await fileOf(form, `drawing-${n}`, 'A drawing') });
    const { image, calls } = await refadePageStep(input, Number(spec.index), current, drawings);
    return jpegResponse(image, calls);
  });
}
