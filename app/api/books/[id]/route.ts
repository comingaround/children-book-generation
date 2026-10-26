import { HttpError, respond } from '@/lib/http-error';
import { deleteBook, requireBook, saveBook } from '@/lib/store';
import type { Book } from '@/lib/types';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return respond('book', { status: 500, message: 'Could not load the book' }, async () => Response.json(await requireBook((await params).id)));
}

/** Saves the editable parts: title, cast, settings and each page's type, scene and cast. Images and text stay as imported. */
export async function PUT(req: Request, { params }: Ctx) {
  return respond('book:save', { status: 500, message: 'Could not save the book' }, async () => {
    const book = await requireBook((await params).id);
    const body = (await req.json()) as Partial<Book>;
    if (typeof body.title === 'string' && body.title.trim()) book.title = body.title.trim();
    if (Array.isArray(body.characters)) book.characters = body.characters;
    if (body.settings) book.settings = { ...book.settings, ...body.settings };
    const ids = new Set(book.characters.map((c) => c.id));
    for (const edit of body.pages ?? []) {
      const page = book.pages.find((p) => p.index === edit.index);
      if (!page) throw new HttpError(400, `No page ${edit.index}`);
      page.kind = edit.kind ?? page.kind;
      page.scenePrompt = edit.scenePrompt ?? page.scenePrompt;
      // Drop entries for characters that were removed from the book.
      if (edit.cast) page.cast = Object.fromEntries(Object.entries(edit.cast).filter(([id]) => ids.has(id)));
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
