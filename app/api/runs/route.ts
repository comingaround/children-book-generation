import { HttpError, respond } from '@/lib/http-error';
import { createRun, type Assignment } from '@/lib/runner';
import { listRuns, requireBook } from '@/lib/store';
import { testPages } from '@/lib/types';

export async function GET() {
  return respond('runs', { status: 500, message: 'Could not list runs' }, async () => Response.json(await listRuns()));
}

/**
 * `assignments`: which person replaces which book character. `pages`: 'test' = cover + 3 story
 * pages, 'all' = every page with an assigned character, or explicit indexes.
 */
export async function POST(req: Request) {
  return respond('runs:create', { status: 500, message: 'Could not start the run' }, async () => {
    const body = (await req.json()) as { bookId?: string; assignments?: Assignment[]; pages?: 'test' | 'all' | number[]; reuseDrawings?: boolean };
    if (!body.bookId) throw new HttpError(400, 'Choose a book');
    const assignments = (body.assignments ?? []).filter((a) => a.characterId && a.personId);
    const book = await requireBook(body.bookId);
    const ids = assignments.map((a) => a.characterId);
    const pages = Array.isArray(body.pages) ? body.pages : testPages(book, body.pages === 'all' ? 'all' : 3, ids);
    return Response.json(await createRun(book.id, assignments, pages, body.reuseDrawings !== false));
  });
}
