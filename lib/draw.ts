import 'server-only';

import sharp from 'sharp';

import { generateImage, generateJson, type InlineImage } from './ai/gemini';
import { characterPrompt, pagePrompt, textRewritePrompt, textRewriteSchema, type PromptMember, type TextRewrite } from './ai/prompts';
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
import { readDataFile } from './store';
import { swapNames, textChanges, type TextCast } from './text';
import { canDrawTogether, castOn, type Book, type BookCharacter, type Box, type Page, type PersonFacts } from './types';

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
export async function drawCharacter(book: Book, characterId: string, person: PersonFacts, photo: Buffer): Promise<Buffer> {
  const character = characterOf(book, characterId);
  const style = book.pages.find((p) => p.kind === 'cover') ?? book.pages[0];
  const styleArt = await readDataFile(`books/${book.id}/${style.image}`);

  const images = [await forModel(photo, 1536), await forModel(styleArt, 1536)];
  const sample = book.pages.find((p) => p.kind !== 'skip' && p.cast[characterId]?.present && p.cast[characterId].box);
  if (sample) {
    const art = sample === style ? styleArt : await readDataFile(`books/${book.id}/${sample.image}`);
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
export async function drawPageStep(book: Book, index: number, art: Buffer | null, members: PageMember[], fix: string | null, fixFor: string | null): Promise<Buffer> {
  const page = pageOf(book, index);
  if (!members.length) throw new HttpError(400, 'No one to draw on this page');
  if (members.length > 1 && !canDrawTogether(book, page, members.map((m) => m.characterId))) throw new HttpError(400, 'These characters cannot be drawn at once on this page');
  const original = art ?? (await readDataFile(`books/${book.id}/${page.image}`));

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
  const answer = await generateImage([padded.image, ...refs], pagePrompt(book, page, prompted, closeUp, fixFor ? null : fix), { aspectRatio: padded.ratio });
  const edited = await unpad(answer, padded.crop, region.width, region.height);

  // Keep the rest outside the boxes; without that setting, still feather a close-up's edge.
  const kept = boxes.filter((b): b is Box => !!b);
  const keep = book.settings.keepOutsideBox && kept.length ? kept : closeUp ? [EDGE_FEATHER] : [];
  if (!keep.length) return toJpeg(edited);
  const before = await sharp(original).extract(region).png().toBuffer();
  const after = await blendInBox(before, edited, keep, region.width, region.height);
  return toJpeg(closeUp ? await pasteRegion(original, after, region) : after);
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
