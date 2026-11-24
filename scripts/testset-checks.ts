/**
 * Offline test of the page checks on real answers (data/testset/, exported from the browser by
 * /api/dev/testset), with the text-model inspection (a fraction of a cent per version).
 * npx tsx --conditions react-server scripts/testset-checks.ts [filter]
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { hairOf } from '../lib/draw';
import { facesOnOriginal, inspectAnswer } from '../lib/inspect';
import type { Book, Box } from '../lib/types';

interface SavedStep {
  attempts: { file: string }[];
  selected?: number | null;
}
interface SavedRun {
  cast: (SavedStep & { characterId: string })[];
  pages: Record<string, SavedStep>;
}

const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
// Known bad versions (owner review, 22 Nov), "run:index:version".
const BAD: Record<string, string> = {
  'mwp6:5:1': 'leftover ponytail',
  'p11-try1': 'face too big',
  'mwp6:9:1': 'swap',
  'mwp6:11:1': 'swap',
  'mwp6:13:1': 'head room / big head',
};
(async () => {
  const book: Book = JSON.parse(fs.readFileSync('data/books/noah-and-lina-giveaway/book.json', 'utf8'));
  // Every run saved under data/testset/ (see /api/dev/testset).
  for (const runId of fs.readdirSync('data/testset')) {
    const run: SavedRun = JSON.parse(fs.readFileSync(`data/testset/${runId}/run.json`, 'utf8'));
    const drawings: Record<string, Buffer> = {};
    const hairs: Record<string, string | undefined> = {};
    for (const c of run.cast) {
      drawings[c.characterId] = fs.readFileSync(c.attempts[c.selected ?? 0].file.replace('idb:runs/', 'data/testset/'));
      hairs[c.characterId] = (await hairOf(drawings[c.characterId]))?.hair;
    }
    for (const [idx, step] of Object.entries(run.pages)) {
      const page = book.pages.find((p) => p.index === Number(idx))!;
      if (page.seeThrough) continue;
      const ids = run.cast.map((c) => c.characterId).filter((id) => page.cast[id]?.present && page.cast[id]?.box);
      const boxes = ids.map((id) => page.cast[id].box as Box);
      const original = await sharp(`data/books/noah-and-lina-giveaway/${page.image}`).png().toBuffer();
      const faces = await facesOnOriginal(original, boxes);
      // Plain redraws of page 11 on 24 Nov, as the AI drew them (rejected; the owner chose try 3).
      const extra = runId === 'run-mwp6xwj9421fa2' && idx === '13' ? ['mwuqbg1k', 'mwuqcr9u', 'mwuqecgy'].map((id, t) => ({ file: `data/debug/rejected/noah-and-lina-giveaway-page13-try${t + 1}-${id}.jpg`, tag: `p11-try${t + 1}` })) : [];
      const versions = [...step.attempts.map((a, v) => ({ file: a.file.replace('idb:runs/', 'data/testset/'), tag: `${runId.slice(4, 8)}:${idx}:${v + 1}` })), ...extra];
      for (const { file, tag } of versions) {
        if (tag === 'p11-try2') continue; // re-posed: rejected by the people-moved check, not this one
        if (only && !tag.startsWith(only)) continue;
        const answer = await sharp(file).resize(page.imageWidth, page.imageHeight, { fit: 'fill' }).png().toBuffer();
        const problems = await inspectAnswer(answer, boxes, ids.map((id) => drawings[id]), faces, ids.map((id) => hairs[id]));
        const flagged = problems.length > 0;
        const expect = BAD[tag];
        const verdict = flagged === !!expect ? 'OK ' : flagged ? 'FALSE ALARM' : 'MISSED';
        console.log(`${verdict} ${tag} ${expect ? `[bad: ${expect}]` : '[good]'} ${problems.join('; ') || 'ok'}`);
      }
    }
  }
})();
