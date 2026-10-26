import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { HttpError, respond } from '@/lib/http-error';
import { dataPath, listBooks } from '@/lib/store';

const exec = promisify(execFile);
const MAX_PDF_BYTES = 200 * 1024 * 1024;

export async function GET() {
  return respond('books', { status: 500, message: 'Could not list books' }, async () => Response.json(await listBooks()));
}

/** Imports an uploaded PDF with scripts/import_pdf.py and returns the new book's id. */
export async function POST(req: Request) {
  return respond('books:import', { status: 500, message: 'Import failed' }, async () => {
    const file = (await req.formData()).get('pdf');
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.pdf')) throw new HttpError(400, 'Choose a PDF file');
    if (file.size > MAX_PDF_BYTES) throw new HttpError(413, 'That PDF is over 200 MB');

    const slug = file.name.replace(/\.pdf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'book';
    let id = slug;
    for (let n = 2; existsSync(dataPath('books', id)); n++) id = `${slug}-${n}`;

    const uploads = dataPath('uploads');
    await mkdir(uploads, { recursive: true });
    const tmp = join(uploads, `${id}.pdf`);
    await writeFile(tmp, Buffer.from(await file.arrayBuffer()));
    try {
      await exec('python', ['-I', join(process.cwd(), 'scripts', 'import_pdf.py'), tmp, '--id', id], { timeout: 300_000 });
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? '');
      const reason = stderr.match(/IMPORT_ERROR: (.*)/)?.[1];
      throw new HttpError(422, reason ? `Import failed: ${reason}` : 'Import failed — is Python with PyMuPDF installed?', stderr || String(err));
    } finally {
      await rm(tmp, { force: true });
    }
    return Response.json({ id });
  });
}
