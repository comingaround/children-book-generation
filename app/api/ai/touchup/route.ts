import { bookFrom } from '@/lib/book-input';
import { touchUpPageStep } from '@/lib/draw';
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
  fix: string | null;
}

/** The owner's "Edit this version" (see touchUpPageStep). Multipart: `spec` and `current`. Local only. */
export async function POST(req: Request) {
  return respond('ai:touchup', { status: 500, message: 'Something went wrong — try again' }, async () => {
    localOnly();
    spendImage(req);
    const form = await req.formData();
    const spec = specOf<Spec>(form);
    const input = await bookFrom(spec, form);
    const current = await fileOf(form, 'current', 'The version to edit');
    return jpegResponse(await touchUpPageStep(input, Number(spec.index), current, spec.characterIds ?? [], spec.fix?.trim() || null));
  });
}
