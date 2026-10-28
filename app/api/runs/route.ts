import { HttpError, respond } from '@/lib/http-error';
import { createRun, type Assignment } from '@/lib/runner';
import { listRuns, requireBook } from '@/lib/store';
import { PREVIEW_PAGES, testPages } from '@/lib/types';

export async function GET() {
  return respond('runs', { status: 500, message: 'Could not list runs' }, async () => Response.json(await listRuns()));
}

/**
 * `assignments`: which person replaces which book character. `pages`: 'test' = cover + 3 story
 * pages, 'preview' = a customer's free preview (cover + PREVIEW_PAGES), 'all' = every page with
 * an assigned character, or explicit indexes. `together`: all characters on a page in one image call.
 */
export async function POST(req: Request) {
  return respond('runs:create', { status: 500, message: 'Could not start the run' }, async () => {
    const body = (await req.json()) as { bookId?: string; assignments?: Assignment[]; pages?: 'test' | 'preview' | 'all' | number[]; reuseDrawings?: boolean; together?: boolean };
    if (!body.bookId) throw new HttpError(400, 'Choose a book');
    const assignments = (body.assignments ?? []).filter((a) => a.characterId && a.personId);
    const book = await requireBook(body.bookId);
    const ids = assignments.map((a) => a.characterId);
    const count = body.pages === 'all' ? 'all' : body.pages === 'preview' ? PREVIEW_PAGES : 3;
    const pages = Array.isArray(body.pages) ? body.pages : testPages(book, count, ids);
    return Response.json(await createRun(book.id, assignments, pages, body.reuseDrawings !== false, body.together === true, body.pages === 'preview'));
  });
}
