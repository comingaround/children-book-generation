import 'server-only';

import sharp from 'sharp';

import { generateImage, generateJson, type InlineImage } from './ai/gemini';
import { characterPrompt, hairStudyPrompt, hairStudySchema, pagePrompt, platePrompt, textRewritePrompt, textRewriteSchema, touchUpPrompt, type HairStudy, type PromptMember, type TextRewrite } from './ai/prompts';
import { cachedJson, sha1 } from './cache';
import { HOSTED } from './hosted';
import { HttpError } from './http-error';
import { facesOnOriginal, forInspect, inspectAnswer } from './inspect';
import { readDataFile, writeDataFile } from './store';
import {
  blendInBox,
  boxInRegion,
  boxRegion,
  closeUpRegion,
  cutRegion,
  drifts,
  EDGE_FEATHER,
  fadePeople,
  type FadePerson,
  forModel,
  headOf,
  keepOriginalIn,
  looksFaded,
  measureOpacity,
  padToRatio,
  pasteRegion,
  personAreas,
  rawAt,
  removeCast,
  sceneDrift,
  softenToOriginal,
  textMask,
  toJpeg,
  unionBox,
  unpad,
  type HairFit,
  type Region,
} from './images';
import type { BookInput } from './book-input';
import { swapNames, textChanges, type TextCast } from './text';
import { canDrawTogether, castOn, characterArt, type Book, type BookCharacter, type Box, type Page, type PersonFacts } from './types';

/**
 * The paid image calls, one request each. Nothing is saved here: the browser sends the person's
 * photo and drawing with every call and keeps what comes back (lib/local/runner.ts runs the loop).
 */

export function characterOf(book: Book, id: string): BookCharacter {
  const character = book.characters.find((c) => c.id === id);
  if (!character) throw new HttpError(404, 'That character is no longer in the book');
  return character;
}

export function pageOf(book: Book, index: number): Page {
  const page = book.pages.find((p) => p.index === index);
  if (!page) throw new HttpError(404, `Page ${index} not found`);
  return page;
}

// ---- the hair of an approved drawing ---------------------------------------------------

const hairStudies = new Map<string, Promise<HairStudy>>();

/**
 * The person's hairstyle, read off their approved drawing by the text model (a fraction of a
 * cent), once per drawing (kept, locally also on disk: lib/cache.ts): the words go into every
 * page's prompt, how far the hair falls sets how much of the drawing the page gets, and its size
 * sets the room left around the head. null if the study fails: the page is then drawn as before.
 */
export async function hairOf(drawing: Buffer): Promise<HairStudy | null> {
  const study = cachedJson(hairStudies, 'hair', sha1(drawing, hairStudyPrompt, JSON.stringify(hairStudySchema)), async () => generateJson<HairStudy>([await forModel(drawing, 1024)], hairStudyPrompt, hairStudySchema));
  return study.then((s) => (console.log(`[hair] ${s.reach}, ${s.volume}, ends at ${s.bottom}: ${s.hair}`), s)).catch((err) => (console.error('[hair]', (err as Error).message), null));
}

const fitOf = (s: HairStudy | null): HairFit | undefined => (s ? { volume: s.volume, reach: s.reach } : undefined);

// ---- step 1: a person, drawn in the book's style ---------------------------------------

/** The drawing as a JPEG. Images: the photo, the cover (for the style), the original character if boxed. */
export async function drawCharacter({ book, read }: BookInput, characterId: string, person: PersonFacts, photo: Buffer): Promise<Buffer> {
  const character = characterOf(book, characterId);
  const style = characterArt(book, characterId).style;
  const styleArt = await read(style.image);

  const images = [await forModel(photo, 1536), await forModel(styleArt, 1536)];
  const { sample } = characterArt(book, characterId);
  if (sample) {
    const art = sample === style ? styleArt : await read(sample.image);
    const crop = await sharp(art).extract(boxRegion(sample.cast[characterId].box!, sample.imageWidth, sample.imageHeight)).toBuffer();
    images.push(await forModel(crop, 1024));
  }

  const png = await generateImage(images, characterPrompt(book, character, person, images.length === 3), { aspectRatio: '3:4' });
  return toJpeg(png);
}

// ---- step 2: one image call on a page ----------------------------------------------------

/** One character on a page, with the files the browser sent. */
export interface PageMember {
  characterId: string;
  person: PersonFacts;
  photo: Buffer;
  /** Their approved drawing; only its head is sent to the model. */
  drawing: Buffer;
}

/** Answers per page before it fails (each one is a paid image). */
const DRAW_TRIES = 3;
/** Scene moved: mean blurred grey difference outside the people (good answers ~1–5). */
const SCENE_DRIFT_LIMIT = Number(process.env.SCENE_DRIFT_LIMIT) || 9;
/** People moved: the same inside their bodies (approved pages up to 17, broken ones 32–53). */
const PEOPLE_DRIFT_LIMIT = Number(process.env.PEOPLE_DRIFT_LIMIT) || 18;

type ImageSize = '1K' | '2K' | '4K';
/**
 * 4K for pages: drawn all at once, each face is small in the model's view; 4x the pixels keeps
 * likeness, curls and glasses (GEMINI_PAGE_IMAGE_SIZE to change it).
 */
const PAGE_IMAGE_SIZE = (process.env.GEMINI_PAGE_IMAGE_SIZE as ImageSize | undefined) ?? '4K';

/** Locally, an image kept to look at as data/debug/<path>-<time>.jpg; never online, never waited for. */
function keepDebug(path: string, image: Buffer): void {
  if (HOSTED) return;
  void toJpeg(image)
    .then((jpg) => writeDataFile(`debug/${path}-${Date.now().toString(36)}.jpg`, jpg))
    .catch(() => {});
}

/** Hosted, a request is cut off at its route's maxDuration (300 s): the image calls stop before. */
const REQUEST_BUDGET_MS = 280_000;
/** No further try is started with less time left than this: slow answers take 140–200 s. */
const MIN_TRY_MS = 120_000;
/** When this request's image calls must be done by (none locally: the dev server has no limit). */
const requestDeadline = () => (HOSTED ? Date.now() + REQUEST_BUDGET_MS : Infinity);

/**
 * Paid image calls until `check` accepts one, at most DRAW_TRIES and none started with less than
 * MIN_TRY_MS left before `deadline` (`draw` gets it, for its own call); else a 502 with
 * `failure`. `calls` counts from `callsSoFar` and is carried on any error too (one from `check`
 * included), so the run's cost counter includes images spent on a page that failed.
 */
async function untilAccepted(
  callsSoFar: number,
  deadline: number,
  draw: (deadline: number) => Promise<Buffer>,
  check: (answer: Buffer, tries: number) => Promise<boolean>,
  failure: string
): Promise<{ image: Buffer; calls: number }> {
  let calls = callsSoFar;
  try {
    for (let tries = 1; tries <= DRAW_TRIES; tries++) {
      if (tries > 1 && deadline - Date.now() < MIN_TRY_MS) {
        console.log(`[draw] no time left for try ${tries}`);
        break;
      }
      const answer = await draw(deadline);
      calls++;
      if (await check(answer, tries)) return { image: answer, calls };
    }
  } catch (err) {
    const counted = err instanceof HttpError ? err : new HttpError(500, 'Something went wrong — try again', err instanceof Error ? err.message : String(err));
    counted.calls = calls;
    throw counted;
  }
  const err = new HttpError(502, failure);
  err.calls = calls;
  throw err;
}

/** The close-up around `pageBoxes` (or the whole page when `closeUp` is off), and each box in it. */
function pageRegion<B extends Box | null>(page: Page, pageBoxes: B[], closeUp: boolean): { region: Region; boxes: B[] } {
  const { imageWidth: w, imageHeight: h } = page;
  if (!closeUp) return { region: { left: 0, top: 0, width: w, height: h }, boxes: pageBoxes };
  const region = closeUpRegion(unionBox(pageBoxes.filter((b): b is NonNullable<B> => !!b)), w, h);
  return { region, boxes: pageBoxes.map((b) => (b ? boxInRegion(b, region, w, h) : b)) as B[] };
}

/** How a character is told apart on this page, for prompts that name them. */
const hintOf = (book: Book, page: Page, id: string) => castOn(page, id).hint || characterOf(book, id).label;

/**
 * One image call that replaces `members` on the page and returns the whole page art as a JPEG.
 * `art` is the page as drawn so far (one by one: the previous character's result), else the book's.
 * With boxes and close-ups on, only the area around their boxes is sent (enlarged), so the figures
 * are big in the model's view; the answer goes back into the page with a soft edge.
 * `fix` is for everyone on the page, or (`fixFor`) for one character only.
 *
 * `given` (local tools only, scripts/finish-answer.ts): an answer the AI already drew, finished as
 * if it had just come back and passed, with no image call and no checks: for an answer the owner
 * judged better than the checks did. The finishing is this function's own, so nothing differs.
 */
export async function drawPageStep({ book, read }: BookInput, index: number, art: Buffer | null, members: PageMember[], fix: string | null, fixFor: string | null, given: Buffer | null = null): Promise<{ image: Buffer; calls: number }> {
  const deadline = requestDeadline();
  const page = pageOf(book, index);
  if (!members.length) throw new HttpError(400, 'No one to draw on this page');
  if (members.length > 1 && !canDrawTogether(book, page, members.map((m) => m.characterId))) throw new HttpError(400, 'These characters cannot be drawn at once on this page');
  const original = art ?? (await read(page.image));

  const pageBoxes = members.map((m) => castOn(page, m.characterId).box);
  const closeUp = pageBoxes.every((b) => b) && book.settings.closeUp !== false;
  // Each member's box in the image the model gets (the close-up, or the whole page).
  const { region, boxes } = pageRegion(page, pageBoxes, closeUp);
  const before = await sharp(original).extract(region).png().toBuffer();
  const kept = boxes.filter((b): b is Box => !!b);
  const people = book.settings.keepOutsideBox && kept.length;
  // The original's faces (text model, once per page): what the answer's faces are held to
  // (lib/inspect.ts). Read while the hair is studied: neither needs the other.
  const faces = people ? facesOnOriginal(before, kept) : Promise.resolve([]);

  const hair = await Promise.all(members.map((m) => hairOf(m.drawing)));
  const refs: InlineImage[] = (await Promise.all(members.map(async (m, i) => [await forModel(await headOf(m.drawing, (hair[i]?.bottom ?? 0) / 1000), 1024), await forModel(m.photo, 1024)]))).flat();
  const prompted: PromptMember[] = members.map((m, i) => ({
    character: characterOf(book, m.characterId),
    person: m.person,
    box: boxes[i],
    fix: fix && fixFor === m.characterId ? fix : null,
    hair: hair[i]?.hair,
  }));

  const padded = await padToRatio(closeUp ? await cutRegion(original, region) : original);
  // Keep the rest outside the boxes; without that setting, still feather a close-up's edge.
  const placed = boxes.flatMap((b, i) => (b ? [{ box: b, fit: fitOf(hair[i]), drawing: members[i].drawing, hair: hair[i]?.hair }] : []));
  const personAreasOf = placed.map((p) => personAreas(p.box, region.width, region.height, p.fit));
  const keep = people ? personAreasOf.flatMap((a) => a.areas) : closeUp ? [EDGE_FEATHER] : [];
  const prompt = pagePrompt(book, page, prompted, closeUp, fixFor ? null : fix);

  // The model sometimes ignores "same framing": it zooms, redraws the room, or re-poses the people
  // (Noah & Lina cover and page 4, 19 Nov). Pasted back, such an answer shows as a patch over the
  // original. It is thrown away and drawn again; after DRAW_TRIES the page fails instead.
  // Long hair's room (side and back), left out of the people-moved check.
  const hairRoom = placed.flatMap((p, i) => (p.fit?.reach === 'below-shoulders' ? [personAreasOf[i].areas[0]] : []));
  let shown: InlineImage[] | null = null;
  const check = async (candidate: Buffer, tries: number) => {
    if (!people) return true;
    const moved = await drifts(before, candidate, keep, kept, hairRoom);
    const still = (moved.scene === null || moved.scene <= SCENE_DRIFT_LIMIT) && moved.people <= PEOPLE_DRIFT_LIMIT;
    // Only an answer that kept the scene is looked at by the text model (people swapped, the
    // original's hair left on, a face grown or moved: lib/inspect.ts).
    shown ??= still ? await forInspect(placed.map((p) => p.drawing)) : null;
    const problems = still ? await inspectAnswer(candidate, kept, shown!, await faces, placed.map((p) => p.hair)) : [];
    const ok = still && !problems.length;
    console.log(`[draw] page ${index} try ${tries}: scene ${moved.scene === null ? 'n/a' : moved.scene.toFixed(1)}, people ${moved.people.toFixed(1)}${problems.length ? `, ${problems.join('; ')}` : ''}${ok ? '' : ' → drawn again'}`);
    // Locally, every answer as the AI drew it: accepted ones (without them, a fault on the
    // finished page can't be told apart between the AI and the blending) and rejected ones.
    keepDebug(`${ok ? 'answers' : 'rejected'}/${book.id}-page${index}-try${tries}`, candidate);
    return ok;
  };
  const drawn = given
    ? { image: await sharp(given).resize(region.width, region.height, { fit: 'fill' }).png().toBuffer(), calls: 0 }
    : await untilAccepted(
        0,
        deadline,
        async (by) => unpad(await generateImage([padded.image, ...refs], prompt, { aspectRatio: padded.ratio, imageSize: PAGE_IMAGE_SIZE, deadline: by }), padded.crop, region.width, region.height),
        check,
        `The AI kept getting this page wrong (scene or people moved, people swapped, the original's hair left on, or a face changed size; ${DRAW_TRIES} tries). Try again, or add a correction.`
      );
  const edited = drawn.image;
  let calls = drawn.calls;
  // The AI's colour cast (the red halo around and on the people) removed before pasting: colour
  // levels only, faces untouched. Each person's correction reaches past their areas as far as the
  // blend's soft edge (~4 feathers), so no tinted rim is left there.
  const reach = Math.min(region.width, region.height) * 0.065;
  const grown = (b: Box): Box => {
    const gx = (reach / region.width) * 100;
    const gy = (reach / region.height) * 100;
    const x = Math.max(0, b.x - gx);
    const y = Math.max(0, b.y - gy);
    return { x, y, w: Math.min(100, b.x + b.w + gx) - x, h: Math.min(100, b.y + b.h + gy) - y };
  };
  let after = edited;
  if (keep.length) {
    const persons = people ? personAreasOf.map((a) => ({ areas: a.areas.map(grown), body: a.body })) : [];
    const clean = people ? await removeCast(before, edited, keep, persons) : edited;
    after = await blendInBox(before, clean, keep, region.width, region.height, people ? 0 : undefined, people ? 'out' : 'in');
  }
  // A see-through page the owner didn't mark (the drafting AI missed Noah & Lina page 12) shows
  // as people far stronger than the book's: a free pixel check, then faded like a marked page.
  let seeThrough = page.seeThrough ?? 0;
  let drawnSolid = false;
  if (!seeThrough && people) {
    const look = await looksFaded(before, after, personAreasOf.map((a) => a.body));
    if (look.faded) {
      console.log(`[fade] page ${index} not marked see-through, but the original's people are at ${look.strength.map((s) => Math.round(s * 100)).join(' · ')}% of the drawn ones: fading them`);
      seeThrough = 50;
      drawnSolid = true;
    }
  }
  if (seeThrough && placed.length) {
    const hints = members.filter((_, i) => boxes[i]).map((m) => hintOf(book, page, m.characterId));
    const done = await finishSeeThrough({ bookId: book.id, index, original: before, hints, people: personAreasOf, seeThrough, closeUp, deadline }, after, drawnSolid, calls);
    after = done.image;
    calls = done.calls;
  }
  return { image: await toJpeg(await keepText(page, closeUp ? await pasteRegion(original, after, region) : after, read)), calls };
}

/** A see-through page being finished (finishSeeThrough, fadeToPage). */
interface SeeThroughJob {
  bookId: string;
  index: number;
  /** The book's own art, the same size as the drawn version (the close-up, or the whole page). */
  original: Buffer;
  /** How each person is told apart, for the plate's prompt. */
  hints: string[];
  people: FadePerson[];
  /** The page's setting (0–90): only the fallback when the strength can't be measured. */
  seeThrough: number;
  closeUp: boolean;
  /** When the request's image calls must be done by (requestDeadline). */
  deadline: number;
}

/**
 * The see-through people of a page, finished. Drawn faded by the AI (a marked page's prompt asks
 * for the book's washed-out look), they are softened wherever still stronger than the book's,
 * free (softenToOriginal). Only if they then still read clearly stronger (looksFaded), or were
 * drawn solid (`drawnSolid`: a page nobody marked), does the plate fade run: one more image call
 * unless that picture's plate is cached, softened again after.
 */
async function finishSeeThrough(job: SeeThroughJob, drawn: Buffer, drawnSolid: boolean, calls: number): Promise<{ image: Buffer; calls: number }> {
  const { index, original, people } = job;
  const soften = async (image: Buffer) => {
    const soft = await softenToOriginal(original, image, people);
    const said = soft.profiles.map((bands) => bands.map((b) => `${Math.round(b.ink * 100)}${b.colour < 0.99 ? `c${Math.round(b.colour * 100)}` : ''}`).join('/'));
    console.log(`[soften] page ${index}: kept ${said.join(' · ')}% top to bottom (c = colour kept)`);
    return soft.image;
  };
  let image = drawn;
  if (!drawnSolid) {
    image = await soften(image);
    const look = await looksFaded(original, image, people.map((p) => p.body));
    if (!look.faded) return { image, calls };
    console.log(`[soften] page ${index}: people still at ${look.strength.map((s) => Math.round(s * 100)).join(' · ')}% of the book's strength: fading over a plate`);
  }
  const faded = await fadeToPage(job, image, calls);
  return { image: await soften(faded.image), calls: faded.calls };
}

/**
 * See-through pages (page.seeThrough): the people were drawn solid; one more image call draws the
 * same picture without them (the plate), and they are mixed back over it at the original's
 * strength, so the border and paper show through them as in the book. That strength is measured
 * from the original's bodies against the plate; the page's seeThrough is only the fallback. A
 * plate that moved the scene is drawn again, like a page. `calls` so far in, the total out.
 */
async function fadeToPage({ bookId, index, original, hints, people, seeThrough, closeUp, deadline }: SeeThroughJob, drawn: Buffer, calls: number): Promise<{ image: Buffer; calls: number }> {
  const areas = people.flatMap((p) => p.areas);
  const { width = 0, height = 0 } = await sharp(drawn).metadata();
  const padded = await padToRatio(drawn);
  const prompt = platePrompt(hints, closeUp);
  const fadeWith = async (plate: Buffer, said: string) => {
    const measured = await measureOpacity(original, drawn, plate, people);
    const fallback = 1 - seeThrough / 100;
    const profiled = people.map((p, i) => ({ ...p, profile: measured[i] ?? [fallback] }));
    const at = profiled.map((p, i) => (measured[i] ? p.profile.map((a) => Math.round(a * 100)).join('/') : `${Math.round(fallback * 100)} (page setting, could not measure)`));
    console.log(`[fade] page ${index} ${said}, people at ${at.join(' · ')}% top to bottom`);
    return fadePeople(drawn, plate, profiled);
  };
  // Locally, a plate is kept per picture: the same version faded again costs nothing.
  const cacheKey = `debug/plates/cache/${sha1(drawn, prompt)}.jpg`;
  if (!HOSTED) {
    const cached = await readDataFile(cacheKey).catch(() => null);
    if (cached) return { image: await fadeWith(await sharp(cached).resize(width, height, { fit: 'fill' }).png().toBuffer(), 'plate from cache'), calls };
  }
  let said = '';
  const plate = await untilAccepted(
    calls,
    deadline,
    async (by) => unpad(await generateImage([padded.image], prompt, { aspectRatio: padded.ratio, imageSize: PAGE_IMAGE_SIZE, deadline: by }), padded.crop, width, height),
    async (candidate, tries) => {
      const scene = await sceneDrift(drawn, candidate, areas);
      const ok = scene === null || scene <= SCENE_DRIFT_LIMIT;
      said = `plate try ${tries}: scene ${scene === null ? 'n/a' : scene.toFixed(1)}`;
      // Locally, every plate is kept to look at (data/debug/plates/), a moved one with the rejects.
      keepDebug(`plates/${bookId}-page${index}-try${tries}`, candidate);
      if (!ok) {
        console.log(`[fade] page ${index} ${said} → drawn again`);
        keepDebug(`rejected/${bookId}-page${index}-plate${tries}`, candidate);
      }
      return ok;
    },
    `The AI kept moving the scene while clearing the background for the see-through people (${DRAW_TRIES} tries). Try again in a moment.`
  );
  if (!HOSTED) await writeDataFile(cacheKey, await toJpeg(plate.image)).catch(() => {});
  return { image: await fadeWith(plate.image, said), calls: plate.calls };
}

/**
 * "Match the fade" on a see-through page: a finished version keeps its faces and poses, and only
 * how faded its people are changes, to the original's (finishSeeThrough): softened for free, and
 * only if still clearly stronger, re-mixed over a plate drawn from the version itself (one image
 * call, none if that version's plate is cached). It can only fade further: a version already
 * fainter than the original stays as it is. `drawings`: approved drawings, for the hair's room.
 */
export async function refadePageStep({ book, read }: BookInput, index: number, current: Buffer, drawings: { characterId: string; drawing: Buffer }[]): Promise<{ image: Buffer; calls: number }> {
  const deadline = requestDeadline();
  const page = pageOf(book, index);
  if (!page.seeThrough) throw new HttpError(400, 'This page has no see-through people');
  const onPage = drawings.filter((d) => castOn(page, d.characterId).present && castOn(page, d.characterId).box);
  if (!onPage.length) throw new HttpError(400, 'No one with a box on this page');
  const closeUp = book.settings.closeUp !== false;
  const { region, boxes } = pageRegion(page, onPage.map((d) => castOn(page, d.characterId).box as Box), closeUp);
  const hair = await Promise.all(onPage.map((d) => hairOf(d.drawing)));
  const people = boxes.map((b, i) => personAreas(b, region.width, region.height, fitOf(hair[i])));
  const hints = onPage.map((d) => hintOf(book, page, d.characterId));

  const original = await sharp(await read(page.image)).extract(region).png().toBuffer();
  const version = await sharp(current).extract(region).png().toBuffer();
  const faded = await finishSeeThrough({ bookId: book.id, index, original, hints, people, seeThrough: page.seeThrough, closeUp, deadline }, version, false, 0);
  return { image: await toJpeg(await keepText(page, closeUp ? await pasteRegion(current, faded.image, region) : faded.image, read)), calls: faded.calls };
}

/**
 * "Edit this version": changes a finished version of a page (by default only the clothing, back
 * to the original's colours and finish) instead of drawing it again from the book's art. Same
 * close-up and keep-outside-the-boxes rules as drawPageStep, so the rest stays pixel-identical.
 */
export async function touchUpPageStep({ book, read }: BookInput, index: number, current: Buffer, characterIds: string[], fix: string | null): Promise<Buffer> {
  const page = pageOf(book, index);
  const characters = characterIds.map((id) => characterOf(book, id)).filter((c) => castOn(page, c.id).present);
  if (!characters.length) throw new HttpError(400, 'No one to change on this page');
  const pageBoxes = characters.map((c) => castOn(page, c.id).box).filter((b): b is Box => !!b);
  const closeUp = pageBoxes.length === characters.length && book.settings.closeUp !== false;
  const { region, boxes } = pageRegion(page, pageBoxes, closeUp);

  const original = await read(page.image);
  const base = await padToRatio(closeUp ? await cutRegion(current, region) : current);
  const reference = await padToRatio(closeUp ? await cutRegion(original, region) : original);
  const answer = await generateImage([base.image, reference.image], touchUpPrompt(book, page, characters, fix), { aspectRatio: base.ratio });
  const edited = await unpad(answer, base.crop, region.width, region.height);

  const people = book.settings.keepOutsideBox && boxes.length;
  const keep = people ? boxes.flatMap((b) => personAreas(b, region.width, region.height).areas) : closeUp ? [EDGE_FEATHER] : [];
  if (!keep.length) return toJpeg(await keepText(page, edited, read));
  const before = await sharp(current).extract(region).png().toBuffer();
  const after = await blendInBox(before, edited, keep, region.width, region.height, people ? 0 : undefined, people ? 'out' : 'in');
  return toJpeg(await keepText(page, closeUp ? await pasteRegion(current, after, region) : after, read));
}

/**
 * Puts the original art back inside the page's text areas (page.textBoxes): text printed in the
 * picture is never redrawn or blended. Without this, a character box overlapping a speech bubble
 * mixed the AI's slightly shifted lettering with the original's, a ghosted double.
 */
async function keepText(page: Page, result: Buffer, read: BookInput['read']): Promise<Buffer> {
  // Text written across someone's head (page 14's "The End" over the children's faces) can't be
  // kept: the original faces would come back with it. That text is left to the redraw.
  const heads = Object.values(page.cast)
    .filter((c) => c.present && c.box)
    .map((c) => ({ ...c.box!, h: c.box!.h * 0.45 }));
  const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const textBoxes = (page.textBoxes ?? []).filter((t) => !heads.some((h) => overlaps(t, h)));
  if (!textBoxes.length) return result;
  // Both decoded once, at the page's size, for the mask and the paste.
  const [original, sized] = await Promise.all([rawAt(await read(page.image), page.imageWidth, page.imageHeight), rawAt(result, page.imageWidth, page.imageHeight)]);
  // Only the bubble itself comes back (textMask): a rectangle with margins around it took back
  // everything near the bubble too, and cut new hair hanging beside it (Mama's ponytail, Noah &
  // Lina page 11, 24 Nov). Text printed straight on the art still gets its padded rectangle.
  return keepOriginalIn(sized, original, await textMask(original, sized, textBoxes));
}

// ---- he/she in the text ------------------------------------------------------------------

/**
 * When someone plays a character of the other gender, the cheap text model rewrites the book's
 * text once for the run: names swapped, and he/she and the like changed for that character only.
 * By page index, one string per line; pages that came back wrong keep the names-only text.
 */
export async function rewriteText(book: Book, cast: TextCast[]): Promise<Record<string, string[]>> {
  const { names, changes } = textChanges(book, cast);
  const pages = book.pages.filter((p) => p.kind !== 'skip' && p.lines.length).map((p) => ({ page: p.index, lines: p.lines.map((l) => swapNames(l.text, names)) }));
  if (!changes.length || !pages.length) return {};

  const answer = await generateJson<TextRewrite>([], textRewritePrompt(pages, changes), textRewriteSchema);
  const text: Record<string, string[]> = {};
  for (const { page, lines } of pages) {
    const got = answer.pages.find((p) => p.page === page)?.lines;
    // A page that came back with a different number of lines keeps the names-only text.
    if (got?.length === lines.length && got.some((l, i) => l !== lines[i])) text[page] = got;
  }
  return text;
}
