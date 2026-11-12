import { rm } from 'node:fs/promises';

import { localOnly } from '@/lib/hosted';
import { respond } from '@/lib/http-error';
import { exportPdf } from '@/lib/pdf';
import { dataPath, requireBook, saveExample, writeDataFile } from '@/lib/store';
import { chosenFile, type Example, type PersonFacts, type Run, type RunStep } from '@/lib/types';
import { fileOf, specOf } from '@/lib/upload';

export const maxDuration = 300;

interface Spec {
  run: Run;
  cast: (PersonFacts & { characterId: string })[];
}

/**
 * Publishes a finished run as an example (the owner, on the local version): its files go to
 * data/examples/<run id>/ and the PDF is made from the book there (scripts/export_pdf.py). The next
 * deploy (scripts/stage-deploy.mjs) takes it online. Multipart: `spec`, and every file the run
 * shows as `file:<key>` (each step's chosen version, each person's photo as `photo:<characterId>`).
 */
export async function POST(req: Request) {
  return respond('examples', { status: 500, message: 'Could not publish the example' }, async () => {
    localOnly();
    const form = await req.formData();
    const { run, cast } = specOf<Spec>(form);
    const book = await requireBook(run.bookId);
    const id = run.id;
    const dir = `examples/${id}`;
    const name = (key: string) => key.split('/').pop()!;
    // Publishing again replaces the example: no files of an earlier version stay behind.
    await rm(dataPath('examples', id), { recursive: true, force: true });

    /** Keeps the version a step shows, copied into the example's folder. */
    const keep = async (step: RunStep, sub: string): Promise<RunStep> => {
      const file = chosenFile(step);
      if (!file) return { ...step, attempts: [], selected: null };
      const path = `${dir}/${sub}/${name(file)}`;
      await writeDataFile(path, await fileOf(form, `file:${file}`, 'A page'));
      const attempt = step.attempts[step.selected ?? step.attempts.length - 1];
      return { ...step, attempts: [{ ...attempt, file: path }], selected: 0, message: null, fix: null, fixFor: null };
    };

    const pages: Record<string, RunStep> = {};
    for (const [index, step] of Object.entries(run.pages)) pages[index] = await keep(step, 'pages');
    const castSteps = await Promise.all(run.cast.map(async (step) => ({ ...step, ...(await keep(step, 'cast')) })));
    const published: Run = { ...run, pages, cast: castSteps, preview: false, ordered: true };

    const people: Example['cast'] = [];
    for (const person of cast) {
      const photo = `${dir}/people/${person.characterId}.jpg`;
      await writeDataFile(photo, await fileOf(form, `photo:${person.characterId}`, `${person.name}'s photo`));
      const drawing = chosenFile(castSteps.find((s) => s.characterId === person.characterId)!) ?? '';
      people.push({ ...person, photo, drawing });
    }

    // The PDF, from the book's original (the best export), with the art just saved.
    const names = cast.flatMap((p): [string, string][] => {
      const from = book.characters.find((c) => c.id === p.characterId)?.nameInText.trim();
      return from ? [[from, p.name]] : [];
    });
    const art: Record<string, Buffer> = {};
    for (const [index, step] of Object.entries(pages)) {
      const file = chosenFile(step);
      if (file) art[index] = await fileOf(form, `file:${run.pages[index] && chosenFile(run.pages[index])}`, 'A page');
    }
    const pdf = `${dir}/book.pdf`;
    await writeDataFile(pdf, await exportPdf(book, { art, names, text: run.text }));

    const example: Example = { id, bookId: book.id, publishedAt: new Date().toISOString(), run: published, cast: people, pdf };
    await saveExample(example);
    return Response.json(example);
  });
}
