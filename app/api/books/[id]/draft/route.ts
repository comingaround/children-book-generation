import { generateJson } from '@/lib/ai/gemini';
import { bookDraftPrompt, bookDraftSchema, pageDraftPrompt, pageDraftSchema, type BookDraft, type PageDraft } from '@/lib/ai/prompts';
import { HttpError, respond } from '@/lib/http-error';
import { forModel } from '@/lib/images';
import { readDataFile, requireBook } from '@/lib/store';
import type { BookSettings, Box } from '@/lib/types';

/**
 * "Draft with AI": the cheap text model reads the art and writes first versions of the prompts.
 * Body `{}` drafts the book settings; `{ index, settings? }` drafts one page and finds the hero's box.
 * Nothing is saved here — the editor applies the draft and autosaves.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond('draft', { status: 500, message: 'Drafting failed' }, async () => {
    const book = await requireBook((await params).id);
    const { index, settings } = (await req.json().catch(() => ({}))) as { index?: number; settings?: Partial<BookSettings> };
    // The editor sends what is on screen; autosave may not have written it yet.
    if (settings) book.settings = { ...book.settings, ...settings };
    const art = (image: string) => readDataFile(`books/${book.id}/${image}`).then((b) => forModel(b, 1024));

    if (index === undefined) {
      const picks = [book.pages.find((p) => p.kind === 'cover'), book.pages.find((p) => p.kind === 'page' && p.hasProtagonist)].filter((p) => !!p);
      return Response.json(await generateJson<BookDraft>(await Promise.all(picks.map((p) => art(p.image))), bookDraftPrompt(book), bookDraftSchema));
    }

    const page = book.pages.find((p) => p.index === index);
    if (!page) throw new HttpError(404, `No page ${index}`);
    const draft = await generateJson<PageDraft>([await art(page.image)], pageDraftPrompt(book, page), pageDraftSchema);
    let box: Box | null = null;
    if (draft.hasProtagonist && draft.box?.length === 4) {
      const [ymin, xmin, ymax, xmax] = draft.box.map((n) => Math.min(Math.max(n / 10, 0), 100));
      const r = (n: number) => Math.round(n * 10) / 10;
      if (xmax > xmin && ymax > ymin) box = { x: r(xmin), y: r(ymin), w: r(xmax - xmin), h: r(ymax - ymin) };
    }
    return Response.json({ ...draft, box });
  });
}
