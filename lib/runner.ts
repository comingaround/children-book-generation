import 'server-only';

import sharp from 'sharp';

import { generateImage, generateJson } from './ai/gemini';
import { characterPrompt, checkPassed, pageCheckPrompt, pageCheckSchema, pagePrompt, type PageCheck } from './ai/prompts';
import { HttpError } from './http-error';
import {
  blendInBox,
  boxInRegion,
  closeUpRegion,
  cutRegion,
  forModel,
  headOf,
  padToRatio,
  pasteRegion,
  toJpeg,
  unpad,
  type Region,
} from './images';
import {
  chosenFile,
  getRun,
  newId,
  readDataFile,
  requireBook,
  requireChild,
  requireRun,
  saveChild,
  saveRun,
  writeFileIn,
} from './store';
import { FIX_MAX, type Book, type Child, type Page, type Run, type RunStep } from './types';

/**
 * A run lives in the dev server's memory while it works and on disk in data/runs/<id>/run.json,
 * which the run page polls. Step 1 draws the character and stops for approval; step 2 makes
 * the pages, two at a time (Google's image capacity is the bottleneck, not our CPU).
 */

const PAGE_CONCURRENCY = 2;
/** When Google is still busy after the client's own retries, a page gets one more go this much later. */
const BUSY_RETRY_MS = 30_000;

const g = globalThis as unknown as {
  runLocks?: Map<string, Promise<unknown>>;
  runWorkers?: Map<string, number>;
  busyRetried?: Set<string>;
};
const locks = (g.runLocks ??= new Map());
const workers = (g.runWorkers ??= new Map());
const busyRetried = (g.busyRetried ??= new Set());

/** Load, change and save a run with no other change in between (page workers run in parallel). */
function mutate(runId: string, change: (run: Run) => void): Promise<Run> {
  const next = (locks.get(runId) ?? Promise.resolve()).then(async () => {
    const run = await requireRun(runId);
    change(run);
    await saveRun(run);
    return run;
  });
  locks.set(runId, next.catch(() => undefined));
  return next;
}

const emptyStep = (status: RunStep['status']): RunStep => ({ status, attempts: [], selected: null, message: null });

const errorMessage = (err: unknown) => (err instanceof HttpError ? err.userMessage : 'Something went wrong — try again');

const retryNote = (attempt: number, of: number) => `AI busy, retrying ${attempt}/${of}`;

const pageOf = (book: Book, index: number): Page => {
  const page = book.pages.find((p) => p.index === index);
  if (!page) throw new HttpError(404, `Page ${index} not found`);
  return page;
};

// ---- create ----------------------------------------------------------------------

export async function createRun(bookId: string, childId: string, pageIndexes: number[], reuseCharacter: boolean): Promise<Run> {
  const book = await requireBook(bookId);
  const child = await requireChild(childId);
  if (!child.photo) throw new HttpError(400, 'This child has no photo');
  if (!pageIndexes.length) throw new HttpError(400, 'No pages with the hero to generate');

  const run: Run = {
    id: newId('run'),
    bookId,
    childId,
    createdAt: new Date().toISOString(),
    status: 'character',
    pageIndexes,
    character: { ...emptyStep('queued'), approved: false, reused: false },
    pages: Object.fromEntries(pageIndexes.map((i) => [String(i), emptyStep('waiting')])),
    images: 0,
  };

  const saved = child.characters[book.id];
  if (reuseCharacter && saved) {
    const file = await writeFileIn(`runs/${run.id}/character-1.png`, await readDataFile(saved));
    run.character = { status: 'done', attempts: [{ file, at: run.createdAt, ms: 0 }], selected: 0, message: null, approved: true, reused: true };
    run.status = 'pages';
    for (const step of Object.values(run.pages)) step.status = 'queued';
  }
  await saveRun(run);

  if (run.status === 'pages') void pumpPages(run.id);
  else void drawCharacter(run.id);
  return run;
}

// ---- step 1: the character ------------------------------------------------------------

async function drawCharacter(runId: string): Promise<void> {
  const started = Date.now();
  const run = await mutate(runId, (r) => {
    r.status = 'character';
    r.character.status = 'working';
    r.character.message = null;
  });
  try {
    const book = await requireBook(run.bookId);
    const child = await requireChild(run.childId);
    const style = book.pages.find((p) => p.kind === 'cover') ?? book.pages[0];
    const styleArt = await readDataFile(`books/${book.id}/${style.image}`);

    const images = [await forModel(await readDataFile(child.photo!), 1536), await forModel(styleArt, 1536)];
    const heroPage = book.pages.find((p) => p.kind !== 'skip' && p.hasProtagonist && p.box);
    if (heroPage?.box) {
      const art = heroPage === style ? styleArt : await readDataFile(`books/${book.id}/${heroPage.image}`);
      const { box } = heroPage;
      const crop = await sharp(art)
        .extract({
          left: Math.round((box.x / 100) * heroPage.imageWidth),
          top: Math.round((box.y / 100) * heroPage.imageHeight),
          width: Math.max(1, Math.round((box.w / 100) * heroPage.imageWidth)),
          height: Math.max(1, Math.round((box.h / 100) * heroPage.imageHeight)),
        })
        .toBuffer();
      images.push(await forModel(crop, 1024));
    }

    const png = await generateImage(images, characterPrompt(book, child, images.length === 3), {
      aspectRatio: '3:4',
      onRetry: (a, of) => void mutate(runId, (r) => void (r.character.message = retryNote(a, of))),
    });

    const file = await writeFileIn(`runs/${runId}/character-${Date.now().toString(36)}.png`, png);
    await mutate(runId, (r) => {
      r.images++;
      r.character.status = 'done';
      r.character.message = null;
      r.character.attempts.push({ file, at: new Date().toISOString(), ms: Date.now() - started });
      r.character.selected = r.character.attempts.length - 1;
      r.status = 'review';
    });
  } catch (err) {
    console.error('[run] character', err instanceof Error ? err.message : err);
    await mutate(runId, (r) => {
      r.character.status = 'error';
      r.character.message = errorMessage(err);
      r.status = r.character.attempts.length ? 'review' : 'character';
    });
  }
}

export async function regenerateCharacter(runId: string): Promise<void> {
  const run = await requireRun(runId);
  if (run.character.status === 'working') throw new HttpError(409, 'The character is already being drawn');
  if (run.character.approved) throw new HttpError(409, 'The character is already approved');
  void drawCharacter(runId);
}

export async function selectCharacter(runId: string, attempt: number): Promise<Run> {
  return mutate(runId, (r) => {
    if (r.character.approved) throw new HttpError(409, 'The character is already approved');
    if (!r.character.attempts[attempt]) throw new HttpError(400, 'No such attempt');
    r.character.selected = attempt;
  });
}

/** Saves the drawing on the child for reuse with this book, then starts the pages. */
export async function approveCharacter(runId: string): Promise<Run> {
  const run = await mutate(runId, (r) => {
    if (!chosenFile(r.character)) throw new HttpError(409, 'There is no character to approve yet');
    r.character.approved = true;
    r.status = 'pages';
    for (const step of Object.values(r.pages)) if (step.status === 'waiting') step.status = 'queued';
  });
  const child = await requireChild(run.childId);
  child.characters[run.bookId] = await writeFileIn(`children/${child.id}/characters/${run.bookId}.png`, await readDataFile(chosenFile(run.character)!));
  await saveChild(child);
  void pumpPages(runId);
  return run;
}

// ---- step 2: the pages ------------------------------------------------------------------

/** Starts queued pages until PAGE_CONCURRENCY are working. */
async function pumpPages(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  let free = PAGE_CONCURRENCY - (workers.get(runId) ?? 0);
  for (const index of run.pageIndexes) {
    if (free <= 0) break;
    if (run.pages[index]?.status !== 'queued') continue;
    free--;
    workers.set(runId, (workers.get(runId) ?? 0) + 1);
    void drawPage(runId, index).finally(() => {
      workers.set(runId, (workers.get(runId) ?? 1) - 1);
      void pumpPages(runId);
    });
  }
  if ((workers.get(runId) ?? 0) === 0) {
    await mutate(runId, (r) => {
      const steps = Object.values(r.pages);
      if (r.status === 'pages' && steps.every((s) => s.status === 'done' || s.status === 'error')) r.status = 'done';
    });
  }
}

/** The page with the child in place, plus the area around the main character before and after (for the check). */
interface Drawn {
  result: Buffer;
  before: Buffer;
  after: Buffer;
}

/**
 * One image call for a page. With a box and close-ups on, only the area around the box is
 * sent (enlarged), so the figure is big in the model's view: sharper faces on small figures
 * and pose kept better. The answer goes back into the page with a soft edge.
 */
async function render(book: Book, page: Page, child: Child, run: Run, fix: string | null, onRetry: (a: number, of: number) => void): Promise<Drawn> {
  const art = await readDataFile(`books/${book.id}/${page.image}`);
  const { imageWidth: w, imageHeight: h } = page;
  const head = await forModel(await headOf(await readDataFile(chosenFile(run.character)!)), 1024);
  const photo = await forModel(await readDataFile(child.photo!), 1024);
  const closeUp = !!page.box && book.settings.closeUp !== false;

  const region: Region = closeUp ? closeUpRegion(page.box!, w, h) : { left: 0, top: 0, width: w, height: h };
  const source = closeUp ? await cutRegion(art, region) : art;
  const padded = await padToRatio(source);
  const box = page.box ? (closeUp ? boxInRegion(page.box, region, w, h) : page.box) : null;

  const answer = await generateImage([padded.image, head, photo], pagePrompt(book, page, child, fix, { closeUp, box }), {
    aspectRatio: padded.ratio,
    onRetry,
  });
  const edited = await unpad(answer, padded.crop, region.width, region.height);
  const before = await sharp(art).extract(region).png().toBuffer();

  // Keep the original outside the main character's box; without that setting, still feather
  // the close-up's edge so it melts into the page.
  const keepBox = book.settings.keepOutsideBox && box ? box : closeUp ? { x: 3, y: 3, w: 94, h: 94 } : null;
  const after = keepBox ? await blendInBox(before, edited, keepBox, region.width, region.height) : edited;
  const result = closeUp ? await pasteRegion(art, after, region) : after;
  return { result, before, after };
}

/** The text model compares before and after; null when the check itself fails (never blocks a page). */
async function checkPage(book: Book, page: Page, run: Run, drawn: Drawn): Promise<PageCheck | null> {
  try {
    const head = await forModel(await headOf(await readDataFile(chosenFile(run.character)!)), 768);
    return await generateJson<PageCheck>(
      [await forModel(drawn.before, 1024), await forModel(drawn.after, 1024), head],
      pageCheckPrompt(book, page),
      pageCheckSchema
    );
  } catch (err) {
    console.warn('[run] check failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/** `auto` marks the one automatic redraw after a failed check, so it can't loop. */
async function drawPage(runId: string, index: number, auto = false): Promise<void> {
  const started = Date.now();
  const run = await mutate(runId, (r) => {
    r.pages[index].status = 'working';
    if (!auto) r.pages[index].message = null;
  });
  try {
    const book = await requireBook(run.bookId);
    const child = await requireChild(run.childId);
    const page = pageOf(book, index);
    const fix = run.pages[index].fix ?? null;

    const drawn = await render(book, page, child, run, fix, (a, of) => void mutate(runId, (r) => void (r.pages[index].message = retryNote(a, of))));
    const file = await writeFileIn(`runs/${runId}/pages/${String(index).padStart(2, '0')}-${Date.now().toString(36)}.jpg`, await toJpeg(drawn.result));

    let check: PageCheck | null = null;
    if (book.settings.autoCheck !== false) {
      await mutate(runId, (r) => void (r.pages[index].message = 'Checking pose, clothing and likeness…'));
      check = await checkPage(book, page, run, drawn);
    }
    const ok = !check || checkPassed(check);
    const correction = check && !ok ? check.correction.trim().slice(0, FIX_MAX) : '';
    const redraw = !ok && !auto && !!correction;

    await mutate(runId, (r) => {
      const step = r.pages[index];
      r.images++;
      step.attempts.push({
        file,
        at: new Date().toISOString(),
        ms: Date.now() - started,
        ...(fix ? { fix, ...(auto ? { auto: true } : {}) } : {}),
        ...(check ? { check: { ok, note: ok ? 'Pose, clothing and likeness look right' : correction || 'Something differs from the original' } } : {}),
      });
      step.selected = step.attempts.length - 1;
      if (redraw) {
        // Keep a person's correction and add the check's to it.
        step.fix = fix ? `${fix}; ${correction}` : correction;
        step.message = `Check: ${correction} — drawing it again`;
      } else {
        step.status = 'done';
        step.message = null;
        step.fix = null;
      }
    });
    busyRetried.delete(`${runId}:${index}`);
    if (redraw) return drawPage(runId, index, true);
  } catch (err) {
    console.error(`[run] page ${index}`, err instanceof Error ? err.message : err);
    const key = `${runId}:${index}`;
    if (err instanceof HttpError && err.status === 503 && !busyRetried.has(key)) {
      busyRetried.add(key);
      await mutate(runId, (r) => {
        r.pages[index].status = 'working';
        r.pages[index].message = 'Google is busy — trying again in 30 s';
      });
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      return drawPage(runId, index, auto);
    }
    busyRetried.delete(key);
    await mutate(runId, (r) => {
      r.pages[index].status = 'error';
      r.pages[index].message = errorMessage(err);
    });
  }
}

/** `fix` is an optional short correction for this one attempt, e.g. "facing away from us, like the original". */
export async function regeneratePage(runId: string, index: number, fix?: string): Promise<Run> {
  const run = await mutate(runId, (r) => {
    const step = r.pages[index];
    if (!step) throw new HttpError(404, 'That page is not in this run');
    if (!r.character.approved) throw new HttpError(409, 'Approve the character first');
    if (step.status === 'working' || step.status === 'queued') throw new HttpError(409, 'That page is already being made');
    step.status = 'queued';
    step.message = null;
    step.fix = fix?.trim().slice(0, FIX_MAX) || null;
    r.status = 'pages';
  });
  void pumpPages(runId);
  return run;
}

export function selectPageAttempt(runId: string, index: number, attempt: number): Promise<Run> {
  return mutate(runId, (r) => {
    const step = r.pages[index];
    if (!step?.attempts[attempt]) throw new HttpError(400, 'No such attempt');
    step.selected = attempt;
  });
}

/**
 * After a dev-server restart nothing is working any more, but the file may still say so.
 * Put interrupted steps back in the queue and carry on.
 */
export async function resumeIfIdle(run: Run): Promise<Run> {
  if ((workers.get(run.id) ?? 0) > 0 || locks.has(run.id)) return run;
  const stuckPages = Object.values(run.pages).some((s) => s.status === 'working' || (s.status === 'queued' && run.status === 'pages'));
  const stuckCharacter = run.character.status === 'working' || run.character.status === 'queued';
  if (!stuckPages && !stuckCharacter) return run;

  locks.set(run.id, Promise.resolve());
  const fixed = await mutate(run.id, (r) => {
    for (const s of Object.values(r.pages)) if (s.status === 'working') s.status = 'queued';
  });
  if (stuckCharacter && !fixed.character.approved) void drawCharacter(run.id);
  else void pumpPages(run.id);
  return fixed;
}
