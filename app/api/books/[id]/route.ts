import { HttpError, respond } from '@/lib/http-error';
import { deleteBook, requireBook, saveBook } from '@/lib/store';
import type { Book } from '@/lib/types';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return respond('book', { status: 500, message: 'Could not load the book' }, async () => Response.json(await requireBook((await params).id)));
}

/** Saves the editable parts: title, settings and each page's AI fields. Images and text stay as imported. */
export async function PUT(req: Request, { params }: Ctx) {
  return respond('book:save', { status: 500, message: 'Could not save the book' }, async () => {
    const book = await requireBook((await params).id);
    const body = (await req.json()) as Partial<Book>;
    if (typeof body.title === 'string' && body.title.trim()) book.title = body.title.trim();
    if (body.settings) book.settings = { ...book.settings, ...body.settings };
    for (const edit of body.pages ?? []) {
      const page = book.pages.find((p) => p.index === edit.index);
      if (!page) throw new HttpError(400, `No page ${edit.index}`);
      const { kind, hasProtagonist, box, characterHint, scenePrompt } = edit;
      Object.assign(page, { kind, hasProtagonist, box, characterHint, scenePrompt });
    }
    await saveBook(book);
    return Response.json(book);
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return respond('book:delete', { status: 500, message: 'Could not delete the book' }, async () => {
    await deleteBook((await requireBook((await params).id)).id);
    return Response.json({ ok: true });
  });
}
