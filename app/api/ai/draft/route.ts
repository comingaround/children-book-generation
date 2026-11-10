import { generateJson } from '@/lib/ai/gemini';
import { bookDraftPrompt, bookDraftSchema, pageDraftPrompt, pageDraftSchema, type BookDraft, type PageDraft } from '@/lib/ai/prompts';
import { bookFrom } from '@/lib/book-input';
import { HttpError, respond } from '@/lib/http-error';
import { forModel } from '@/lib/images';
import { specOf } from '@/lib/upload';
import { draftImages, type Book, type Box } from '@/lib/types';

export const maxDuration = 120;

interface Spec {
  bookId?: string;
  book?: Book;
  index?: number;
  characters?: Book['characters'];
  settings?: Partial<Book['settings']>;
}

/**
 * "Prepare with AI": the cheap text model reads the art and writes first versions of the prompts.
 * Multipart `spec`: without `index` it finds the book's characters and art style; with `index` it
 * drafts one page for every character (and finds their boxes). A browser book comes with the art
 * draftImages() names. Nothing is saved here — the editor applies the draft and autosaves, and
 * sends what's on screen (characters, settings), since autosave may not have run yet.
 */
export async function POST(req: Request) {
  return respond('ai:draft', { status: 500, message: 'Drafting failed' }, async () => {
    const form = await req.formData();
    const spec = specOf<Spec>(form);
    const { book, read } = await bookFrom(spec, form);
    if (spec.characters) book.characters = spec.characters;
    if (spec.settings) book.settings = { ...book.settings, ...spec.settings };
    const art = (image: string) => read(image).then((b) => forModel(b, 1024));
    const images = draftImages(book, spec.index);

    if (spec.index === undefined) {
      return Response.json(await generateJson<BookDraft>(await Promise.all(images.map(art)), bookDraftPrompt(book), bookDraftSchema));
    }

    const page = book.pages.find((p) => p.index === spec.index);
    if (!page) throw new HttpError(404, `No page ${spec.index}`);
    if (!book.characters.length) throw new HttpError(400, 'Add a character first');
    const draft = await generateJson<PageDraft>(await Promise.all(images.map(art)), pageDraftPrompt(book, page), pageDraftSchema);
    const r = (n: number) => Math.round(n * 10) / 10;
    const cast = draft.cast
      .filter((c) => book.characters.some((b) => b.id === c.id))
      .map((c) => {
        let box: Box | null = null;
        if (c.present && c.box?.length === 4) {
          const [ymin, xmin, ymax, xmax] = c.box.map((n) => Math.min(Math.max(n / 10, 0), 100));
          if (xmax > xmin && ymax > ymin) box = { x: r(xmin), y: r(ymin), w: r(xmax - xmin), h: r(ymax - ymin) };
        }
        return { ...c, box };
      });
    return Response.json({ scenePrompt: draft.scenePrompt, cast });
  });
}
