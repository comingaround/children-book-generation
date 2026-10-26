import type { Book, Box, Child, Page } from '../types';

const who = (child: Child) => `${child.name}, a ${child.age ? `${child.age}-year-old ` : ''}${child.gender}`;

const notes = (child: Child) => (child.notes.trim() ? ` Notes about the child: ${child.notes.trim()}.` : '');

/** The box in words the model can follow; it reads the image, not our coordinates. */
function where(box: Box): string {
  const pct = (n: number) => `${Math.round(n)}%`;
  return `the area from ${pct(box.x)} to ${pct(box.x + box.w)} across and ${pct(box.y)} to ${pct(box.y + box.h)} down the image`;
}

/** What the main character wears on this page: the page's own outfit, else the book's. */
export const clothingOn = (book: Book, page: Page) => page.clothing?.trim() || book.settings.clothing?.trim() || '';

/**
 * Step 1: draw the child once, in the book's style. Pages then take only the head of this
 * drawing (face, hair, skin), which keeps the child the same on every page.
 * Images: 1 = child photo, 2 = style page, 3 (optional) = crop of the original main character.
 */
export function characterPrompt(book: Book, child: Child, withHeroCrop: boolean): string {
  const s = book.settings;
  const clothing = s.clothing?.trim();
  return [
    `Image 1 is a photo of a real child: ${who(child)}.${notes(child)}`,
    `Image 2 is an illustration from the children's picture book "${book.title}".${s.artStyle ? ` Its art style: ${s.artStyle}.` : ''}`,
    withHeroCrop ? "Image 3 shows the book's original main character. Use it only for the outfit and body proportions; do not copy their face or hair." : '',
    'Draw a character reference of the child from image 1 as a picture-book character, in exactly the art style of image 2: the same line work, colouring, shading, level of detail and body proportions as the characters in that book.',
    'Keep the child clearly recognisable: face shape, eyes, eyebrows, nose, hair colour, hair length and style, skin tone, and any glasses or other distinctive features from the photo.',
    clothing ? `Dress them exactly in the book's outfit: ${clothing}.` : "Dress them like the book's main character.",
    'One full-body figure, standing and facing the viewer in a relaxed neutral pose, on a plain warm off-white background. No other characters, no props, no text.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Step 2, per page: give the original main character the child's face, hair and skin; keep
 * their clothing, pose and place. Images: 1 = page art, 2 = head of the approved drawing,
 * 3 = child photo.
 */
export function pagePrompt(book: Book, page: Page, child: Child, fix?: string | null): string {
  const s = book.settings;
  const hero = page.characterHint.trim() || s.protagonistDescription.trim() || "the book's main character";
  const clothing = clothingOn(book, page);
  const pose = page.pose?.trim();
  const genderSwap =
    s.protagonistGender !== child.gender
      ? ` The new main character is a ${child.gender} while the original was a ${s.protagonistGender}: change the face and hair accordingly, but keep the clothing and pose.`
      : '';
  return [
    `Image 1 is a page illustration from the children's picture book "${book.title}". Image 2 shows the head of the new main character, ${who(child)}, drawn in this book's style. Image 3 is a photo of that child, for likeness only.`,
    `Edit image 1: the main character is ${hero}${page.box ? `, in ${where(page.box)}` : ''}. Give them the face, hair (colour, length and style), skin tone and any glasses from image 2. Take nothing else from image 2.${genderSwap}`,
    `Keep their clothing exactly as in image 1${clothing ? ` (${clothing})` : ''}: same garments, colours and patterns.`,
    `Keep their pose and direction exactly as in image 1${pose ? `: ${pose}` : ''}. Same body position, which way they face, where they look, gestures, expression, size and place in the picture.`,
    'Everything else must stay identical to image 1: the other characters, the background, objects, composition, framing, colours and art style. If the main character appears more than once, change every appearance.',
    page.kind === 'cover' ? 'Keep the book title lettering exactly as it is, letter for letter.' : 'Do not add any text, letters or signatures.',
    page.scenePrompt.trim() ? `About this scene: ${page.scenePrompt.trim()}` : '',
    fix ? `A correction for this version, which takes priority over anything above: ${fix}` : '',
    'Return the whole illustration at the same framing as image 1.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- "Prepare with AI" (cheap text model) -------------------------------------------

export interface PageDraft {
  hasProtagonist: boolean;
  characterHint: string;
  pose: string;
  clothing: string;
  /** True when the outfit on this page differs from the book's usual one. */
  clothingDiffers: boolean;
  scenePrompt: string;
  /** [ymin, xmin, ymax, xmax] on a 0–1000 grid, Gemini's native box format. */
  box: number[] | null;
}

export const pageDraftSchema = {
  type: 'OBJECT',
  properties: {
    hasProtagonist: { type: 'BOOLEAN' },
    characterHint: { type: 'STRING' },
    pose: { type: 'STRING' },
    clothing: { type: 'STRING' },
    clothingDiffers: { type: 'BOOLEAN' },
    scenePrompt: { type: 'STRING' },
    box: { type: 'ARRAY', items: { type: 'INTEGER' }, nullable: true },
  },
  required: ['hasProtagonist', 'characterHint', 'pose', 'clothing', 'clothingDiffers', 'scenePrompt', 'box'],
};

export function pageDraftPrompt(book: Book, page: Page): string {
  const s = book.settings;
  const text = page.lines.map((l) => l.text).join(' ');
  return [
    `This is ${page.kind === 'cover' ? 'the cover' : `page ${page.index}`} of the children's picture book "${book.title}".`,
    s.protagonistName ? `The main character is ${s.protagonistName}${s.protagonistDescription ? `: ${s.protagonistDescription}` : ''}.` : '',
    s.clothing ? `Their usual outfit: ${s.clothing}.` : '',
    text ? `The page text: "${text}"` : '',
    'Answer in JSON:',
    '- hasProtagonist: is the main character visible in the illustration?',
    '- characterHint: one short phrase that picks the main character out from everyone else in THIS picture (clothing, hair, position), e.g. "the red-haired girl in a blue blazer sitting on the left". Empty if not visible.',
    '- pose: their pose and direction in one short phrase. Always start by saying what the viewer sees of them: their face (facing the viewer), their back, or their profile (facing left or right), or a three-quarter view. Then the body position, where they look and what the hands do. E.g. "back to the viewer, standing, looking left at the old trike, arms down". Empty if not visible.',
    '- clothing: what they wear on THIS page, garments and colours. Empty if not visible.',
    '- clothingDiffers: true only if that outfit is clearly different from their usual outfit.',
    '- scenePrompt: one or two sentences describing the scene: setting, what the main character is doing, other characters, mood. No art-style words.',
    '- box: the bounding box around the main character (the whole figure, all of them if shown more than once) as [ymin, xmin, ymax, xmax] on a 0–1000 grid. null if not visible.',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface BookDraft {
  artStyle: string;
  protagonistName: string;
  protagonistGender: 'boy' | 'girl';
  protagonistDescription: string;
  clothing: string;
}

export const bookDraftSchema = {
  type: 'OBJECT',
  properties: {
    artStyle: { type: 'STRING' },
    protagonistName: { type: 'STRING' },
    protagonistGender: { type: 'STRING', enum: ['boy', 'girl'] },
    protagonistDescription: { type: 'STRING' },
    clothing: { type: 'STRING' },
  },
  required: ['artStyle', 'protagonistName', 'protagonistGender', 'protagonistDescription', 'clothing'],
};

export function bookDraftPrompt(book: Book): string {
  const text = book.pages
    .filter((p) => p.kind !== 'skip')
    .flatMap((p) => p.lines.map((l) => l.text))
    .join(' ')
    .slice(0, 4000);
  return [
    `These are the cover and a page of the children's picture book "${book.title}". The book text: "${text}"`,
    'Answer in JSON:',
    '- artStyle: one sentence describing the illustration style (medium, line work, colouring, shading), e.g. "soft watercolour with fine ink outlines and warm pastel washes".',
    "- protagonistName: the main character's first name exactly as written in the text.",
    "- protagonistGender: 'boy' or 'girl'.",
    '- protagonistDescription: how to recognise the main character, without clothing: approximate age, build and hair, e.g. "a 6-year-old boy with short brown hair".',
    '- clothing: their usual outfit, garments and colours with any trim or pattern, e.g. "yellow T-shirt with red trim, blue jeans, red sneakers".',
  ].join('\n');
}
