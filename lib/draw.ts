import 'server-only';

import { createHash } from 'node:crypto';

import sharp from 'sharp';

import { generateImage, generateJson, type InlineImage } from './ai/gemini';
import { characterPrompt, hairStudyPrompt, hairStudySchema, pagePrompt, platePrompt, textRewritePrompt, textRewriteSchema, touchUpPrompt, type HairStudy, type PromptMember, type TextRewrite } from './ai/prompts';
import { HttpError } from './http-error';
import { facesOnOriginal, inspectAnswer } from './inspect';
import { readDataFile, writeDataFile } from './store';
import {
  blendInBox,
  boxInRegion,
  boxRegion,
  closeUpRegion,
  cutRegion,
  EDGE_FEATHER,
  fadePeople,
  type FadePerson,
  measureOpacity,
  looksFaded,
  softenToOriginal,
  textMask,
  keepOriginalIn,
  forModel,
  headOf,
  padToRatio,
  pasteRegion,
  personAreas,
  peopleDrift,
  removeCast,
  sceneDrift,
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
 * cent), once per drawing while the server runs: the words go into every page's prompt, how far
 * the hair falls sets how much of the drawing the page gets, and its size sets the room left
 * around the head. null if the study fails: the page is then drawn as before.
 */
export async function hairOf(drawing: Buffer): Promise<HairStudy | null> {
  const key = createHash('sha1').update(drawing).digest('hex');
  let study = hairStudies.get(key);
  if (!study) {
    study = forModel(drawing, 1024).then((image) => generateJson<HairStudy>([image], hairStudyPrompt, hairStudySchema));
    hairStudies.set(key, study);
    study.catch(() => hairStudies.delete(key));
  }
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

/**
 * One image call that replaces `members` on the page and returns the whole page art as a JPEG.
 * `art` is the page as drawn so far (one by one: the previous character's result), else the book's.
 * With boxes and close-ups on, only the area around their boxes is sent (enlarged), so the figures
 * are big in the model's view; the answer goes back into the page with a soft edge.
 * `fix` is for everyone on the page, or (`fixFor`) for one character only.
 */
/** Answers per page before it fails (each one is a paid image). */
const DRAW_TRIES = 3;
/** Scene moved: mean blurred grey difference outside the people (good answers ~1–5). */
const SCENE_DRIFT_LIMIT = Number(process.env.SCENE_DRIFT_LIMIT) || 9;
/** People moved: the same inside their bodies (approved pages up to 17, broken ones 32–53). */
const PEOPLE_DRIFT_LIMIT = Number(process.env.PEOPLE_DRIFT_LIMIT) || 18;

/**
 * `given` (local tools only, scripts/finish-answer.ts): an answer the AI already drew, finished as
 * if it had just come back and passed, with no image call and no checks: for an answer the owner
 * judged better than the checks did. The finishing is this function's own, so nothing differs.
 */
export async function drawPageStep({ book, read }: BookInput, index: number, art: Buffer | null, members: PageMember[], fix: string | null, fixFor: string | null, given: Buffer | null = null): Promise<{ image: Buffer; calls: number }> {
  const page = pageOf(book, index);
  if (!members.length) throw new HttpError(400, 'No one to draw on this page');
  if (members.length > 1 && !canDrawTogether(book, page, members.map((m) => m.characterId))) throw new HttpError(400, 'These characters cannot be drawn at once on this page');
  const original = art ?? (await read(page.image));

  const { imageWidth: w, imageHeight: h } = page;
  const pageBoxes = members.map((m) => castOn(page, m.characterId).box);
  const closeUp = pageBoxes.every((b) => b) && book.settings.closeUp !== false;
  const region: Region = closeUp ? closeUpRegion(unionBox(pageBoxes as Box[]), w, h) : { left: 0, top: 0, width: w, height: h };
  // Each member's box in the image the model gets (the close-up, or the whole page).
  const boxes = pageBoxes.map((b) => (b && closeUp ? boxInRegion(b, region, w, h) : b));

  const hair = await Promise.all(members.map((m) => hairOf(m.drawing)));
  const refs: InlineImage[] = [];
  for (const [i, m] of members.entries()) refs.push(await forModel(await headOf(m.drawing, (hair[i]?.bottom ?? 0) / 1000), 1024), await forModel(m.photo, 1024));
  const prompted: PromptMember[] = members.map((m, i) => ({
    character: characterOf(book, m.characterId),
    person: m.person,
    box: boxes[i],
    fix: fix && fixFor === m.characterId ? fix : null,
    hair: hair[i]?.hair,
  }));

  const padded = await padToRatio(closeUp ? await cutRegion(original, region) : original);
  // 4K for pages: drawn all at once, each face is small in the model's view; 4x the pixels keeps
  // likeness, curls and glasses (GEMINI_PAGE_IMAGE_SIZE to change it).
  const imageSize = (process.env.GEMINI_PAGE_IMAGE_SIZE as '1K' | '2K' | '4K' | undefined) ?? '4K';
  // Keep the rest outside the boxes; without that setting, still feather a close-up's edge.
  const placed = boxes.flatMap((b, i) => (b ? [{ box: b, fit: fitOf(hair[i]), drawing: members[i].drawing, hair: hair[i]?.hair }] : []));
  const kept = placed.map((p) => p.box);
  const people = book.settings.keepOutsideBox && kept.length;
  const before = await sharp(original).extract(region).png().toBuffer();
  // The original's faces (text model, once per page): what the answer's faces are held to (lib/inspect.ts).
  const faces = people ? await facesOnOriginal(before, kept) : [];
  const personAreasOf = placed.map((p) => personAreas(p.box, region.width, region.height, p.fit));
  const keep = people ? personAreasOf.flatMap((a) => a.areas) : closeUp ? [EDGE_FEATHER] : [];
  const prompt = pagePrompt(book, page, prompted, closeUp, fixFor ? null : fix);

  // The model sometimes ignores "same framing": it zooms, redraws the room, or re-poses the people
  // (Noah & Lina cover and page 4, 19 Nov). Pasted back, such an answer shows as a patch over the
  // original. It is thrown away and drawn again; after DRAW_TRIES the page fails instead.
  // Long hair's room (side and back), left out of the people-moved check.
  const hairRoom = placed.flatMap((p, i) => (p.fit?.reach === 'below-shoulders' ? [personAreasOf[i].areas[0]] : []));
  let edited: Buffer | null = given ? await sharp(given).resize(region.width, region.height, { fit: 'fill' }).png().toBuffer() : null;
  let calls = 0;
  for (let tries = 1; tries <= DRAW_TRIES && !given; tries++) {
    calls++;
    let answer: Buffer;
    try {
      answer = await generateImage([padded.image, ...refs], prompt, { aspectRatio: padded.ratio, imageSize });
    } catch (err) {
      if (err instanceof HttpError) err.calls = calls - 1;
      throw err;
    }
    const candidate = await unpad(answer, padded.crop, region.width, region.height);
    if (!people) {
      edited = candidate;
      break;
    }
    const scene = await sceneDrift(before, candidate, keep);
    const moved = await peopleDrift(before, candidate, kept, hairRoom);
    const still = (scene === null || scene <= SCENE_DRIFT_LIMIT) && moved <= PEOPLE_DRIFT_LIMIT;
    // Only an answer that kept the scene is looked at by the text model (people swapped, the
    // original's hair left on, a face grown or moved: lib/inspect.ts).
    const problems = still ? await inspectAnswer(candidate, kept, placed.map((p) => p.drawing), faces, placed.map((p) => p.hair)) : [];
    const ok = still && !problems.length;
    console.log(`[draw] page ${index} try ${tries}: scene ${scene === null ? 'n/a' : scene.toFixed(1)}, people ${moved.toFixed(1)}${problems.length ? `, ${problems.join('; ')}` : ''}${ok ? '' : ' → drawn again'}`);
    if (ok) {
      edited = candidate;
      // Locally, the accepted answer too, as the AI drew it (data/debug/answers/): without it, a
      // fault on the finished page can't be told apart between the AI and the blending.
      if (!process.env.VERCEL) await writeDataFile(`debug/answers/${book.id}-page${index}-try${tries}-${Date.now().toString(36)}.jpg`, await toJpeg(candidate)).catch(() => {});
      break;
    }
    // Locally, every rejected answer is kept to look at (data/debug/rejected/).
    if (!process.env.VERCEL) await writeDataFile(`debug/rejected/${book.id}-page${index}-try${tries}-${Date.now().toString(36)}.jpg`, await toJpeg(candidate)).catch(() => {});
  }
  if (!edited) {
    const err = new HttpError(502, `The AI kept getting this page wrong (scene or people moved, people swapped, the original's hair left on, or a face changed size; ${DRAW_TRIES} tries). Try again, or add a correction.`);
    err.calls = calls;
    throw err;
  }
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
    const hints = members.filter((_, i) => boxes[i]).map((m) => castOn(page, m.characterId).hint || characterOf(book, m.characterId).label);
    const done = await finishSeeThrough(book.id, index, before, after, hints, personAreasOf, seeThrough, drawnSolid, closeUp, imageSize, calls);
    after = done.image;
    calls = done.calls;
  }
  return { image: await toJpeg(await keepText(page, closeUp ? await pasteRegion(original, after, region) : after, read)), calls };
}

/**
 * The see-through people of a page, finished. Drawn faded by the AI (a marked page's prompt asks
 * for the book's washed-out look), they are softened wherever still stronger than the book's,
 * free (softenToOriginal). Only if they then still read clearly stronger (looksFaded), or were
 * drawn solid (`drawnSolid`: a page nobody marked), does the plate fade run: one more image call
 * unless that picture's plate is cached, softened again after.
 */
async function finishSeeThrough(bookId: string, index: number, original: Buffer, drawn: Buffer, hints: string[], people: FadePerson[], seeThrough: number, drawnSolid: boolean, closeUp: boolean, imageSize: '1K' | '2K' | '4K', calls: number): Promise<{ image: Buffer; calls: number }> {
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
  const faded = await fadeToPage(bookId, index, original, image, hints, people, seeThrough, closeUp, imageSize, calls);
  return { image: await soften(faded.image), calls: faded.calls };
}

/**
 * See-through pages (page.seeThrough): the people were drawn solid; one more image call draws the
 * same picture without them (the plate), and they are mixed back over it at the original's
 * strength, so the border and paper show through them as in the book. That strength is measured
 * from the original's bodies against the plate; the page's seeThrough is only the fallback. A
 * plate that moved the scene is drawn again, like a page. `calls` so far in, the total out.
 */
async function fadeToPage(bookId: string, index: number, original: Buffer, drawn: Buffer, hints: string[], people: FadePerson[], seeThrough: number, closeUp: boolean, imageSize: '1K' | '2K' | '4K', calls: number): Promise<{ image: Buffer; calls: number }> {
  const areas = people.flatMap((p) => p.areas);
  const { width = 0, height = 0 } = await sharp(drawn).metadata();
  const padded = await padToRatio(await sharp(drawn).jpeg({ quality: 95 }).toBuffer());
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
  const cacheKey = `debug/plates/cache/${createHash('sha1').update(drawn).update(prompt).digest('hex')}.jpg`;
  if (!process.env.VERCEL) {
    const cached = await readDataFile(cacheKey).catch(() => null);
    if (cached) return { image: await fadeWith(await sharp(cached).resize(width, height, { fit: 'fill' }).png().toBuffer(), 'plate from cache'), calls };
  }
  for (let tries = 1; tries <= DRAW_TRIES; tries++) {
    calls++;
    let answer: Buffer;
    try {
      answer = await generateImage([padded.image], prompt, { aspectRatio: padded.ratio, imageSize });
    } catch (err) {
      if (err instanceof HttpError) err.calls = calls - 1;
      throw err;
    }
    const plate = await unpad(answer, padded.crop, width, height);
    const scene = await sceneDrift(drawn, plate, areas);
    const ok = scene === null || scene <= SCENE_DRIFT_LIMIT;
    // Locally, every plate is kept to look at (data/debug/plates/).
    if (!process.env.VERCEL) await writeDataFile(`debug/plates/${bookId}-page${index}-try${tries}-${Date.now().toString(36)}.jpg`, await toJpeg(plate)).catch(() => {});
    if (ok) {
      if (!process.env.VERCEL) await writeDataFile(cacheKey, await toJpeg(plate)).catch(() => {});
      return { image: await fadeWith(plate, `plate try ${tries}: scene ${scene === null ? 'n/a' : scene.toFixed(1)}`), calls };
    }
    console.log(`[fade] page ${index} plate try ${tries}: scene ${scene === null ? 'n/a' : scene.toFixed(1)} → drawn again`);
    if (!process.env.VERCEL) await writeDataFile(`debug/rejected/${bookId}-page${index}-plate${tries}-${Date.now().toString(36)}.jpg`, await toJpeg(plate)).catch(() => {});
  }
  const err = new HttpError(502, `The AI kept moving the scene while clearing the background for the see-through people (${DRAW_TRIES} tries). Try again in a moment.`);
  err.calls = calls;
  throw err;
}

/**
 * "Match the fade" on a see-through page: a finished version keeps its faces and poses, and only
 * how faded its people are changes, to the original's (finishSeeThrough): softened for free, and
 * only if still clearly stronger, re-mixed over a plate drawn from the version itself (one image
 * call, none if that version's plate is cached). It can only fade further: a version already
 * fainter than the original stays as it is. `drawings`: approved drawings, for the hair's room.
 */
export async function refadePageStep({ book, read }: BookInput, index: number, current: Buffer, drawings: { characterId: string; drawing: Buffer }[]): Promise<{ image: Buffer; calls: number }> {
  const page = pageOf(book, index);
  if (!page.seeThrough) throw new HttpError(400, 'This page has no see-through people');
  const onPage = drawings.filter((d) => castOn(page, d.characterId).present && castOn(page, d.characterId).box);
  if (!onPage.length) throw new HttpError(400, 'No one with a box on this page');
  const { imageWidth: w, imageHeight: h } = page;
  const pageBoxes = onPage.map((d) => castOn(page, d.characterId).box as Box);
  const closeUp = book.settings.closeUp !== false;
  const region: Region = closeUp ? closeUpRegion(unionBox(pageBoxes), w, h) : { left: 0, top: 0, width: w, height: h };
  const boxes = closeUp ? pageBoxes.map((b) => boxInRegion(b, region, w, h)) : pageBoxes;
  const hair = await Promise.all(onPage.map((d) => hairOf(d.drawing)));
  const areasOf = boxes.map((b, i) => personAreas(b, region.width, region.height, fitOf(hair[i])));
  const hints = onPage.map((d) => castOn(page, d.characterId).hint || characterOf(book, d.characterId).label);
  const imageSize = (process.env.GEMINI_PAGE_IMAGE_SIZE as '1K' | '2K' | '4K' | undefined) ?? '4K';

  const original = await sharp(await read(page.image)).extract(region).png().toBuffer();
  const version = await sharp(current).extract(region).png().toBuffer();
  const faded = await finishSeeThrough(book.id, index, original, version, hints, areasOf, page.seeThrough, false, closeUp, imageSize, 0);
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
  const { imageWidth: w, imageHeight: h } = page;
  const pageBoxes = characters.map((c) => castOn(page, c.id).box).filter((b): b is Box => !!b);
  const closeUp = pageBoxes.length === characters.length && book.settings.closeUp !== false;
  const region: Region = closeUp ? closeUpRegion(unionBox(pageBoxes), w, h) : { left: 0, top: 0, width: w, height: h };
  const boxes = closeUp ? pageBoxes.map((b) => boxInRegion(b, region, w, h)) : pageBoxes;

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
  const original = await sharp(await read(page.image)).resize(page.imageWidth, page.imageHeight).png().toBuffer();
  const sized = await sharp(result).resize(page.imageWidth, page.imageHeight).png().toBuffer();
  // Only the bubble itself comes back (textMask): a rectangle with margins around it took back
  // everything near the bubble too, and cut new hair hanging beside it (Mama's ponytail, Noah &
  // Lina page 11, 24 Nov). Text printed straight on the art still gets its padded rectangle.
  return keepOriginalIn(sized, original, await textMask(original, sized, textBoxes, page.imageWidth, page.imageHeight));
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
