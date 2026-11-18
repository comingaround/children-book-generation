import 'server-only';

import sharp from 'sharp';

import { generateImage, generateJson, type InlineImage } from './ai/gemini';
import { characterPrompt, pagePrompt, textRewritePrompt, textRewriteSchema, touchUpPrompt, type PromptMember, type TextRewrite } from './ai/prompts';
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
  personAreas,
  sceneDrift,
  matchColours,
  blendPeople,
  type PersonArea,
  toJpeg,
  unionBox,
  unpad,
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
/** Image calls per page: the first and up to two redraws of an answer that moved the scene. */
const DRAW_TRIES = 3;
/**
 * Mean grey difference (0–255, 96 px, blurred) outside the people above which an answer counts as
 * a reframe. A faithful answer copies the background almost exactly (a few levels); a zoom or a
 * redrawn room moves every edge. Logged on every page, to tune.
 */
const SCENE_DRIFT_LIMIT = Number(process.env.SCENE_DRIFT_LIMIT) || 9;

export async function drawPageStep({ book, read }: BookInput, index: number, art: Buffer | null, members: PageMember[], fix: string | null, fixFor: string | null): Promise<{ image: Buffer; calls: number }> {
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

  const refs: InlineImage[] = [];
  for (const m of members) refs.push(await forModel(await headOf(m.drawing), 1024), await forModel(m.photo, 1024));
  const prompted: PromptMember[] = members.map((m, i) => ({
    character: characterOf(book, m.characterId),
    person: m.person,
    box: boxes[i],
    fix: fix && fixFor === m.characterId ? fix : null,
  }));

  const padded = await padToRatio(closeUp ? await cutRegion(original, region) : original);
  // 4K for pages: drawn all at once, each face is small in the model's view; 4x the pixels keeps
  // likeness, curls and glasses (GEMINI_PAGE_IMAGE_SIZE to change it).
  const imageSize = (process.env.GEMINI_PAGE_IMAGE_SIZE as '1K' | '2K' | '4K' | undefined) ?? '4K';
  const prompt = pagePrompt(book, page, prompted, closeUp, fixFor ? null : fix);

  // Keep the rest outside the boxes; without that setting, still feather a close-up's edge.
  const kept = boxes.filter((b): b is Box => !!b);
  const people = book.settings.keepOutsideBox && kept.length;
  const persons: PersonArea[] = people ? kept.map((b) => {
    const [head, body] = personAreas(b, region.width, region.height);
    return { head, body };
  }) : [];
  const keep = people ? persons.flatMap((p) => [p.head, p.body]) : closeUp ? [EDGE_FEATHER] : [];
  const before = await sharp(original).extract(region).png().toBuffer();

  // The model sometimes ignores "same framing" and zooms in or redraws the room (Noah & Lina,
  // Page 2): its answer is then off everywhere, not only on the people. Such an answer is thrown
  // away and drawn again; after DRAW_TRIES the page fails rather than show a broken picture.
  let edited: Buffer | null = null;
  let calls = 0;
  for (let tries = 1; tries <= DRAW_TRIES; tries++) {
    calls++;
    const answer = await generateImage([padded.image, ...refs], prompt, { aspectRatio: padded.ratio, imageSize });
    const candidate = await unpad(answer, padded.crop, region.width, region.height);
    const drift = people ? await sceneDrift(before, candidate, keep) : null;
    console.log(`[draw] page ${index} try ${tries}: scene drift ${drift === null ? 'n/a (close-up)' : drift.toFixed(1)}`);
    if (drift === null || drift <= SCENE_DRIFT_LIMIT) {
      edited = candidate;
      break;
    }
  }
  if (!edited) {
    throw new HttpError(502, `The AI kept redrawing the whole scene instead of only the people (${DRAW_TRIES} tries). Try again in a moment.`);
  }

  if (!keep.length) return { image: await toJpeg(await keepText(page, edited, read)), calls };
  // People: the AI's colour cast undone; then the head's changes and the body's bare skin only
  // (no halo, and a repainted garment never reaches the page).
  const after = people
    ? await blendPeople(before, await matchColours(before, edited, keep), persons, region.width, region.height)
    : await blendInBox(before, edited, keep, region.width, region.height, undefined, 'in');
  return { image: await toJpeg(await keepText(page, closeUp ? await pasteRegion(original, after, region) : after, read)), calls };
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
  const persons: PersonArea[] = people ? boxes.map((b) => {
    const [head, body] = personAreas(b, region.width, region.height);
    return { head, body };
  }) : [];
  const keep = people ? persons.flatMap((p) => [p.head, p.body]) : closeUp ? [EDGE_FEATHER] : [];
  if (!keep.length) return toJpeg(await keepText(page, edited, read));
  const before = await sharp(current).extract(region).png().toBuffer();
  const after = people
    ? await blendPeople(before, await matchColours(before, edited, keep), persons, region.width, region.height)
    : await blendInBox(before, edited, keep, region.width, region.height, undefined, 'in');
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
  // The AI's text boxes can sit tight on the letters, and the blend softens the edge inwards: pad them.
  const pad = 3;
  const padded = textBoxes.map((t) => {
    const x = Math.max(0, t.x - pad);
    const y = Math.max(0, t.y - pad);
    return { x, y, w: Math.min(100, t.x + t.w + pad) - x, h: Math.min(100, t.y + t.h + pad) - y };
  });
  return blendInBox(sized, original, padded, page.imageWidth, page.imageHeight, 0.12, 'out');
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
