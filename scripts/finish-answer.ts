/**
 * Finishes a page answer the AI already drew (data/debug/rejected/ or answers/) through the
 * engine's own steps, with no image call: for an answer the owner judged better than the checks.
 * The drawings come from a test-set run (data/testset/<run>/). Writes data/debug/finished/<name>.
 * npx tsx --env-file=.env.local --conditions react-server scripts/finish-answer.ts <run-id> <page-index> <answer.jpg>
 */
import fs from 'node:fs';
import path from 'node:path';
import { drawPageStep } from '../lib/draw';
import { readDataFile, requireBook, writeDataFile } from '../lib/store';

(async () => {
  const [runId, indexArg, answerPath] = process.argv.slice(2);
  const run = JSON.parse(fs.readFileSync(`data/testset/${runId}/run.json`, 'utf8')) as { bookId: string; cast: { characterId: string; selected: number | null; attempts: { file: string }[] }[] };
  const book = await requireBook(run.bookId);
  const index = Number(indexArg);
  const page = book.pages.find((p) => p.index === index)!;
  const members = run.cast
    .filter((c) => page.cast[c.characterId]?.present)
    .map((c) => {
      const drawing = fs.readFileSync(c.attempts[c.selected ?? 0].file.replace('idb:runs/', 'data/testset/'));
      // The person's facts only word the prompt, and no prompt is sent; the photo only goes to the model.
      return { characterId: c.characterId, person: { name: c.characterId, gender: 'girl' as const, age: null, notes: '' }, photo: drawing, drawing };
    });
  const { image } = await drawPageStep({ book, read: (img) => readDataFile(`books/${book.id}/${img}`) }, index, null, members, null, null, fs.readFileSync(answerPath));
  const out = `debug/finished/${path.basename(answerPath)}`;
  await writeDataFile(out, image);
  console.log(`data/${out}`);
})();
