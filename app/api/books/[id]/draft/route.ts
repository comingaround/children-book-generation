import { generateJson } from '@/lib/ai/gemini';
import { bookDraftPrompt, bookDraftSchema, pageDraftPrompt, pageDraftSchema, type BookDraft, type PageDraft } from '@/lib/ai/prompts';
import { HttpError, respond } from '@/lib/http-error';
import { forModel } from '@/lib/images';
import { readDataFile, requireBook } from '@/lib/store';
import type { Book, Box } from '@/lib/types';

/**
 * "Prepare with AI": the cheap text model reads the art and writes first versions of the prompts.
 * Body `{}` finds the book's characters and art style; `{ index, characters?, settings? }` drafts
 * one page for every character (and finds their boxes). Nothing is saved here — the editor applies
 * the draft and autosaves. The editor sends what's on screen, since autosave may not have run yet.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond('draft', { status: 500, message: 'Drafting failed' }, async () => {
    const book = await requireBook((await params).id);
    const body = (await req.json().catch(() => ({}))) as { index?: number; characters?: Book['characters']; settings?: Partial<Book['settings']> };
    if (body.characters) book.characters = body.characters;
    if (body.settings) book.settings = { ...book.settings, ...body.settings };
    const art = (image: string) => readDataFile(`books/${book.id}/${image}`).then((b) => forModel(b, 1024));

    if (body.index === undefined) {
      const story = book.pages.filter((p) => p.kind === 'page');
      const picks = [book.pages.find((p) => p.kind === 'cover'), story[1], story[Math.floor(story.length / 2)]].filter((p) => !!p);
      return Response.json(await generateJson<BookDraft>(await Promise.all(picks.map((p) => art(p.image))), bookDraftPrompt(book), bookDraftSchema));
    }

    const page = book.pages.find((p) => p.index === body.index);
    if (!page) throw new HttpError(404, `No page ${body.index}`);
    if (!book.characters.length) throw new HttpError(400, 'Add a character first');
    const draft = await generateJson<PageDraft>([await art(page.image)], pageDraftPrompt(book, page), pageDraftSchema);
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
