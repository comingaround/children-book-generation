import { HttpError, respond } from '@/lib/http-error';
import { createRun } from '@/lib/runner';
import { listRuns, requireBook } from '@/lib/store';
import { testPages } from '@/lib/types';

export async function GET() {
  return respond('runs', { status: 500, message: 'Could not list runs' }, async () => Response.json(await listRuns()));
}

/** `pages`: 'test' = cover + 3 story pages, 'all' = every page with the hero, or explicit indexes. */
export async function POST(req: Request) {
  return respond('runs:create', { status: 500, message: 'Could not start the run' }, async () => {
    const body = (await req.json()) as { bookId?: string; childId?: string; pages?: 'test' | 'all' | number[]; reuseCharacter?: boolean };
    if (!body.bookId || !body.childId) throw new HttpError(400, 'Choose a book and a child');
    const book = await requireBook(body.bookId);
    const pages = Array.isArray(body.pages) ? body.pages : testPages(book, body.pages === 'all' ? 'all' : 3);
    const run = await createRun(book.id, body.childId, pages, body.reuseCharacter !== false);
    return Response.json(run);
  });
}
