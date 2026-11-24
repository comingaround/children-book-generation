import { localOnly } from '@/lib/hosted';
import { HttpError, respond } from '@/lib/http-error';
import { writeDataFile } from '@/lib/store';

/**
 * Local only: the browser keeps runs in IndexedDB; this copies a run's files to data/testset/
 * so the engine's checks can be tried offline on real answers (scripts/testset). Multipart:
 * `path` (letters, digits, - _ . /, no ..) and `file`.
 */
export async function POST(req: Request) {
  return respond('dev:testset', { status: 500, message: 'Could not save' }, async () => {
    localOnly();
    const form = await req.formData();
    const path = String(form.get('path') ?? '');
    const file = form.get('file');
    if (!/^[\w./-]+$/.test(path) || path.includes('..') || !(file instanceof Blob)) throw new HttpError(400, 'Bad path or file');
    await writeDataFile(`testset/${path}`, Buffer.from(await file.arrayBuffer()));
    return Response.json({ ok: true });
  });
}
