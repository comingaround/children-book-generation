import 'server-only';

import sharp from 'sharp';

import { generateImage, type InlineImage } from './ai/gemini';
import { characterPrompt, pagePrompt, type PromptMember } from './ai/prompts';
import { HttpError } from './http-error';
import {
  blendInBox,
  boxInRegion,
  boxRegion,
  closeUpRegion,
  cutRegion,
  EDGE_FEATHER,
  forModel,
  headOf,
  padToRatio,
  pasteRegion,
  toJpeg,
  unionBox,
  unpad,
  type Region,
} from './images';
import { getRun, newId, readDataFile, requireBook, requirePerson, requireRun, savePerson, saveRun, writeFileIn } from './store';
import {
  canDrawTogether,
  castOn,
  chosenFile,
  drawingKey,
  FIX_MAX,
  type Book,
  type BookCharacter,
  type Box,
  type CastStep,
  type Page,
  type Person,
  type Run,
  type RunStep,
} from './types';

/**
 * A run lives in the dev server's memory while it works and on disk in data/runs/<id>/run.json,
 * which the run page polls. Step 1 draws every assigned person in the book's style and stops
 * for approval; step 2 makes the pages, two at a time (Google's image capacity is the
 * bottleneck, not our CPU). On a page, each assigned character is replaced in turn.
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

/** Load, change and save a run with no other change in between (workers run in parallel). */
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

function characterOf(book: Book, id: string): BookCharacter {
  const character = book.characters.find((c) => c.id === id);
  if (!character) throw new HttpError(404, 'That character is no longer in the book');
  return character;
}

function castStep(run: Run, characterId: string): CastStep {
  const step = run.cast.find((c) => c.characterId === characterId);
  if (!step) throw new HttpError(404, 'That character is not in this run');
  return step;
}

/** Busy, waiting for review, or ready for pages, from the state of every cast drawing. */
function castStatus(run: Run): Run['status'] {
  if (run.cast.every((c) => c.approved)) return run.status === 'done' ? 'done' : 'pages';
  return run.cast.every((c) => c.approved || c.status === 'done' || c.status === 'error') ? 'review' : 'character';
}

// ---- create ----------------------------------------------------------------------

export interface Assignment {
  characterId: string;
  personId: string;
}

/** `together`: every character on a page in one image call instead of one call each. */
export async function createRun(bookId: string, assignments: Assignment[], pageIndexes: number[], reuseDrawings: boolean, together = false): Promise<Run> {
  const book = await requireBook(bookId);
  if (!assignments.length) throw new HttpError(400, 'Choose a person for at least one character');
  if (!pageIndexes.length) throw new HttpError(400, 'None of these characters are on any page yet');
  const people = await Promise.all(assignments.map((a) => requirePerson(a.personId)));
  for (const [i, person] of people.entries()) {
    characterOf(book, assignments[i].characterId);
    if (!person.photo) throw new HttpError(400, `${person.name} has no photo`);
  }

  const run: Run = {
    id: newId('run'),
    bookId,
    createdAt: new Date().toISOString(),
    status: 'character',
    pageIndexes,
    together,
    cast: [],
    pages: Object.fromEntries(pageIndexes.map((i) => [String(i), emptyStep('waiting')])),
    images: 0,
  };
  for (const [i, a] of assignments.entries()) {
    const saved = reuseDrawings ? people[i].drawings[drawingKey(book.id, a.characterId)] : undefined;
    if (saved) {
      const file = await writeFileIn(`runs/${run.id}/cast-${a.characterId}-saved.png`, await readDataFile(saved));
      run.cast.push({ ...a, status: 'done', attempts: [{ file, at: run.createdAt, ms: 0 }], selected: 0, message: null, approved: true, reused: true });
    } else {
      run.cast.push({ ...a, ...emptyStep('queued'), approved: false, reused: false });
    }
  }
  run.status = castStatus(run);
  if (run.status === 'pages') for (const step of Object.values(run.pages)) step.status = 'queued';
  await saveRun(run);

  if (run.status === 'pages') void pumpPages(run.id);
  else for (const c of run.cast) if (!c.approved) void drawCharacter(run.id, c.characterId);
  return run;
}

// ---- step 1: the people, drawn in the book's style ---------------------------------------

async function drawCharacter(runId: string, characterId: string): Promise<void> {
  const started = Date.now();
  const run = await mutate(runId, (r) => {
    const step = castStep(r, characterId);
    step.status = 'working';
    step.message = null;
    r.status = castStatus(r);
  });
  try {
    const book = await requireBook(run.bookId);
    const character = characterOf(book, characterId);
    const person = await requirePerson(castStep(run, characterId).personId);
    const style = book.pages.find((p) => p.kind === 'cover') ?? book.pages[0];
    const styleArt = await readDataFile(`books/${book.id}/${style.image}`);

    const images = [await forModel(await readDataFile(person.photo!), 1536), await forModel(styleArt, 1536)];
    const sample = book.pages.find((p) => p.kind !== 'skip' && p.cast[characterId]?.present && p.cast[characterId].box);
    if (sample) {
      const art = sample === style ? styleArt : await readDataFile(`books/${book.id}/${sample.image}`);
      const crop = await sharp(art).extract(boxRegion(sample.cast[characterId].box!, sample.imageWidth, sample.imageHeight)).toBuffer();
      images.push(await forModel(crop, 1024));
    }

    const png = await generateImage(images, characterPrompt(book, character, person, images.length === 3), {
      aspectRatio: '3:4',
      onRetry: (a, of) => void mutate(runId, (r) => void (castStep(r, characterId).message = retryNote(a, of))),
    });

    const file = await writeFileIn(`runs/${runId}/cast-${characterId}-${Date.now().toString(36)}.png`, png);
    await mutate(runId, (r) => {
      const step = castStep(r, characterId);
      r.images++;
      step.status = 'done';
      step.message = null;
      step.attempts.push({ file, at: new Date().toISOString(), ms: Date.now() - started });
      step.selected = step.attempts.length - 1;
      r.status = castStatus(r);
    });
  } catch (err) {
    console.error('[run] character', err instanceof Error ? err.message : err);
    await mutate(runId, (r) => {
      const step = castStep(r, characterId);
      step.status = 'error';
      step.message = errorMessage(err);
      r.status = castStatus(r);
    });
  }
}

export async function regenerateCharacter(runId: string, characterId: string): Promise<Run> {
  const run = await requireRun(runId);
  const step = castStep(run, characterId);
  if (step.status === 'working' || step.status === 'queued') throw new HttpError(409, 'Already being drawn');
  if (step.approved) throw new HttpError(409, 'Already approved');
  void drawCharacter(runId, characterId);
  return run;
}

export function selectCharacter(runId: string, characterId: string, attempt: number): Promise<Run> {
  return mutate(runId, (r) => {
    const step = castStep(r, characterId);
    if (step.approved) throw new HttpError(409, 'Already approved');
    if (!step.attempts[attempt]) throw new HttpError(400, 'No such attempt');
    step.selected = attempt;
  });
}

/** Saves every drawing on its person for reuse with this book, then starts the pages. */
export async function approveCast(runId: string): Promise<Run> {
  const run = await mutate(runId, (r) => {
    for (const step of r.cast) {
      if (step.status === 'working' || step.status === 'queued') throw new HttpError(409, 'Wait until every drawing is finished');
      if (!chosenFile(step)) throw new HttpError(409, 'One of the drawings failed — draw it again first');
    }
    for (const step of r.cast) step.approved = true;
    r.status = 'pages';
    for (const step of Object.values(r.pages)) if (step.status === 'waiting') step.status = 'queued';
  });
  for (const step of run.cast) {
    if (step.reused) continue;
    const person = await requirePerson(step.personId);
    const key = drawingKey(run.bookId, step.characterId);
    person.drawings[key] = await writeFileIn(`children/${person.id}/characters/${run.bookId}-${step.characterId}.png`, await readDataFile(chosenFile(step)!));
    await savePerson(person);
  }
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

/** One character on a page, ready to draw. */
interface Member {
  character: BookCharacter;
  person: Person;
  head: Buffer;
}

/**
 * One image call that replaces `members` on the page. With boxes and close-ups on, only the area
 * around their boxes is sent (enlarged), so the figures are big in the model's view; the answer
 * goes back into the page with a soft edge. One member = one by one, several = all at once.
 */
async function editRegion(
  book: Book,
  page: Page,
  art: Buffer,
  members: Member[],
  fixes: { page: string | null; of: (m: Member) => string | null },
  onRetry: (a: number, of: number) => void
): Promise<Buffer> {
  const { imageWidth: w, imageHeight: h } = page;
  const pageBoxes = members.map((m) => castOn(page, m.character.id).box);
  const closeUp = pageBoxes.every((b) => b) && book.settings.closeUp !== false;
  const region: Region = closeUp ? closeUpRegion(unionBox(pageBoxes as Box[]), w, h) : { left: 0, top: 0, width: w, height: h };
  // Each member's box in the image the model gets (the close-up, or the whole page).
  const boxes = pageBoxes.map((b) => (b && closeUp ? boxInRegion(b, region, w, h) : b));

  const refs: InlineImage[] = [];
  for (const m of members) refs.push(await forModel(m.head, 1024), await forModel(await readDataFile(m.person.photo!), 1024));
  const prompted: PromptMember[] = members.map((m, i) => ({ character: m.character, person: m.person, box: boxes[i], fix: fixes.of(m) }));

  const padded = await padToRatio(closeUp ? await cutRegion(art, region) : art);
  const answer = await generateImage([padded.image, ...refs], pagePrompt(book, page, prompted, closeUp, fixes.page), { aspectRatio: padded.ratio, onRetry });
  const edited = await unpad(answer, padded.crop, region.width, region.height);

  // Keep the rest outside the boxes; without that setting, still feather a close-up's edge.
  const kept = boxes.filter((b): b is Box => !!b);
  const keep = book.settings.keepOutsideBox && kept.length ? kept : closeUp ? [EDGE_FEATHER] : [];
  if (!keep.length) return edited;
  const before = await sharp(art).extract(region).png().toBuffer();
  const after = await blendInBox(before, edited, keep, region.width, region.height);
  return closeUp ? pasteRegion(art, after, region) : after;
}

/**
 * One version of a page. One by one (default): each assigned character replaced in turn on the
 * same image. All at once (run.together, when canDrawTogether): one image call for all of them.
 */
async function drawPage(runId: string, index: number): Promise<void> {
  const started = Date.now();
  const run = await mutate(runId, (r) => {
    r.pages[index].status = 'working';
    r.pages[index].message = null;
  });
  const say = (message: string) => mutate(runId, (r) => void (r.pages[index].message = message));
  try {
    const book = await requireBook(run.bookId);
    const page = pageOf(book, index);
    const { fix = null, fixFor = null } = run.pages[index];
    const members: Member[] = [];
    for (const step of run.cast) {
      if (!page.cast[step.characterId]?.present) continue;
      const character = book.characters.find((b) => b.id === step.characterId);
      if (!character) continue;
      members.push({ character, person: await requirePerson(step.personId), head: await headOf(await readDataFile(chosenFile(step)!)) });
    }
    // A correction is for everyone on the page, or (fixFor) for one character only.
    const fixes = { page: fixFor ? null : fix, of: (m: Member) => (fixFor === m.character.id ? fix : null) };
    const together = !!run.together && canDrawTogether(book, page, members.map((m) => m.character.id));

    let art: Buffer = await readDataFile(`books/${book.id}/${page.image}`);
    if (together) {
      await say('Drawing everyone at once…');
      art = await editRegion(book, page, art, members, fixes, (a, of) => void say(retryNote(a, of)));
      await mutate(runId, (r) => void r.images++);
    } else {
      for (const m of members) {
        const label = members.length > 1 ? `${m.character.label}: ` : '';
        await say(`${label}drawing…`);
        art = await editRegion(book, page, art, [m], fixes, (a, of) => void say(`${label}${retryNote(a, of)}`));
        await mutate(runId, (r) => void r.images++);
      }
    }

    const file = await writeFileIn(`runs/${runId}/pages/${String(index).padStart(2, '0')}-${Date.now().toString(36)}.jpg`, await toJpeg(art));
    await mutate(runId, (r) => {
      const step = r.pages[index];
      step.attempts.push({
        file,
        at: new Date().toISOString(),
        ms: Date.now() - started,
        ...(together ? { together: true } : {}),
        ...(fix ? { fix, ...(fixFor ? { fixFor } : {}) } : {}),
      });
      step.selected = step.attempts.length - 1;
      step.status = 'done';
      step.message = null;
      step.fix = null;
      step.fixFor = null;
    });
    busyRetried.delete(`${runId}:${index}`);
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
      return drawPage(runId, index);
    }
    busyRetried.delete(key);
    await mutate(runId, (r) => {
      r.pages[index].status = 'error';
      r.pages[index].message = errorMessage(err);
    });
  }
}

/**
 * `fix` is an optional short correction for this one attempt, e.g. "facing away from us, like
 * the original"; `fixFor` limits it to one character (default: everyone on the page).
 */
export async function regeneratePage(runId: string, index: number, fix?: string, fixFor?: string | null): Promise<Run> {
  const run = await mutate(runId, (r) => {
    const step = r.pages[index];
    if (!step) throw new HttpError(404, 'That page is not in this run');
    if (!r.cast.every((c) => c.approved)) throw new HttpError(409, 'Approve the drawings first');
    if (step.status === 'working' || step.status === 'queued') throw new HttpError(409, 'That page is already being made');
    if (fixFor && !r.cast.some((c) => c.characterId === fixFor)) throw new HttpError(400, 'That character is not in this run');
    step.status = 'queued';
    step.message = null;
    step.fix = fix?.trim().slice(0, FIX_MAX) || null;
    step.fixFor = step.fix ? fixFor || null : null;
    r.status = 'pages';
  });
  void pumpPages(runId);
  return run;
}

export const setTogether = (runId: string, together: boolean) => mutate(runId, (r) => void (r.together = together));

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
  const stuckCast = run.cast.filter((c) => !c.approved && (c.status === 'working' || c.status === 'queued'));
  if (!stuckPages && !stuckCast.length) return run;

  locks.set(run.id, Promise.resolve());
  const fixed = await mutate(run.id, (r) => {
    for (const s of Object.values(r.pages)) if (s.status === 'working') s.status = 'queued';
  });
  if (stuckCast.length) for (const c of stuckCast) void drawCharacter(run.id, c.characterId);
  else void pumpPages(run.id);
  return fixed;
}
