import 'server-only';

import { createHash } from 'node:crypto';

import sharp from 'sharp';

import { generateJson, type InlineImage } from './ai/gemini';
import { faceOnOriginalPrompt, faceSchema, inspectPrompt, inspectSchema, type FaceAnswer, type InspectAnswer } from './ai/prompts';
import { forModel } from './images';
import { readDataFile, writeDataFile } from './store';
import type { Box } from './types';

/**
 * Checks on a page answer, after the scene and people-moved checks: each one can only reject an
 * answer (it is then drawn again), never change one, so a page that passes comes out exactly as
 * before. Noah & Lina, 20 Nov run: two pages with the children swapped (7 and 9), one with the
 * original's ponytail left on the new girl (3), one with a sleeping boy's head grown into his
 * mother's cheek (11). None of them moved the scene or the bodies enough for the older checks.
 */

/** The image with each box outlined and numbered 1..n, for the text model. */
async function numbered(image: Buffer, boxes: Box[]): Promise<InlineImage> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const stroke = Math.max(3, Math.round(Math.min(width, height) * 0.004));
  const font = Math.max(20, Math.round(Math.min(width, height) * 0.035));
  const marks = boxes.map((b, i) => {
    const [x, y, w, h] = [(b.x / 100) * width, (b.y / 100) * height, (b.w / 100) * width, (b.h / 100) * height];
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ff0000" stroke-width="${stroke}"/>
      <rect x="${x}" y="${y}" width="${font * 1.1}" height="${font * 1.2}" fill="#ff0000"/>
      <text x="${x + font * 0.55}" y="${y + font}" font-size="${font}" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">${i + 1}</text>`;
  });
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${marks.join('')}</svg>`);
  return forModel(await sharp(image).composite([{ input: svg }]).jpeg({ quality: 90 }).toBuffer(), 1536);
}

/** [ymin, xmin, ymax, xmax] in 0–1000 as a Box in %, or null. */
function boxOf(v: number[] | undefined | null): Box | null {
  if (!v || v.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = v.map((n) => Math.min(Math.max(n / 10, 0), 100));
  return xmax > xmin && ymax > ymin ? { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin } : null;
}

const facesCache = new Map<string, Promise<(Box | null)[]>>();

/**
 * The face of the person in each box of the book's own art (`original`, the image the boxes are
 * in), read once by the text model and kept (in memory, and locally on disk): the yardstick for
 * the answer's faces, and the size of a head on pages where a box is far bigger than its head.
 * null for a box whose face can't be seen (from behind); all null if the read fails.
 */
export function facesOnOriginal(original: Buffer, boxes: Box[]): Promise<(Box | null)[]> {
  const key = createHash('sha1').update(original).update(JSON.stringify(boxes)).digest('hex');
  let faces = facesCache.get(key);
  if (!faces) {
    faces = (async () => {
      const file = `cache/faces/${key}.json`;
      const saved = process.env.VERCEL ? null : await readDataFile(file).catch(() => null);
      if (saved) return JSON.parse(saved.toString()) as (Box | null)[];
      const answer = await generateJson<FaceAnswer>([await numbered(original, boxes)], faceOnOriginalPrompt(boxes.length), faceSchema);
      const found = boxes.map((_, i) => {
        const a = answer.people.find((p) => p.box === i + 1);
        return a?.faceVisible ? boxOf(a.face) : null;
      });
      if (!process.env.VERCEL) await writeDataFile(file, Buffer.from(JSON.stringify(found))).catch(() => {});
      return found;
    })();
    facesCache.set(key, faces);
    faces.catch(() => facesCache.delete(key));
  }
  return faces.catch((err) => (console.error('[inspect] faces on the original:', (err as Error).message), boxes.map(() => null)));
}

/**
 * Face size change allowed (new face width × height against the original's, square-rooted). On 46
 * good saved pages the text model measured 80–123%; the oversized faces 132–143%, though one read
 * the same answer at 114% (its face boxes are noisy on small faces).
 */
const FACE_SCALE_LIMIT = 1.28;
/** Face centre moved, in original face heights. */
const FACE_MOVE_LIMIT = 0.6;

/**
 * What is wrong with an answer, in words for the log; [] if nothing. `boxes` are the people
 * redrawn in this call (in `answer`'s %), `drawings` their approved drawings in the same order,
 * `faces` the original's (facesOnOriginal), `hairs` the hair study of each drawing in words (a tie
 * in a small copy of a drawing is easily missed: Mama's low ponytail, page 11, 24 Nov, was called
 * extra). If the text model fails, the answer passes: a check that can't run must not cost a page.
 */
export async function inspectAnswer(answer: Buffer, boxes: Box[], drawings: Buffer[], faces: (Box | null)[], hairs: (string | undefined)[] = []): Promise<string[]> {
  let read: InspectAnswer;
  try {
    const images = [await numbered(answer, boxes), ...(await Promise.all(drawings.map((d) => forModel(d, 768))))];
    read = await generateJson<InspectAnswer>(images, inspectPrompt(boxes.length, hairs), inspectSchema);
  } catch (err) {
    console.error('[inspect]', (err as Error).message);
    return [];
  }
  const problems: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = read.people.find((p) => p.box === i + 1);
    if (!a) continue;
    // Drawing n is image n + 1.
    if (a.who && a.who !== i + 2) problems.push(a.who >= 2 && a.who <= drawings.length + 1 ? `box ${i + 1} holds the person of box ${a.who - 1} (swapped)` : `box ${i + 1} holds someone else`);
    if (a.extraHair.trim()) problems.push(`box ${i + 1} has hair their drawing doesn't: ${a.extraHair.trim()}`);
    const was = faces[i];
    const now = a.faceVisible ? boxOf(a.face) : null;
    if (was && now) {
      const scale = Math.sqrt((now.w * now.h) / (was.w * was.h));
      const moved = Math.hypot(now.x + now.w / 2 - (was.x + was.w / 2), now.y + now.h / 2 - (was.y + was.h / 2)) / was.h;
      if (process.env.INSPECT_LOG_FACES) console.log(`[inspect] box ${i + 1} face ${Math.round(scale * 100)}%, moved ${moved.toFixed(2)}`);
      if (scale > FACE_SCALE_LIMIT || scale < 1 / FACE_SCALE_LIMIT) problems.push(`box ${i + 1}'s face is ${Math.round(scale * 100)}% of the original's size`);
      if (moved > FACE_MOVE_LIMIT) problems.push(`box ${i + 1}'s face moved ${moved.toFixed(1)} face heights`);
    }
  }
  return problems;
}
