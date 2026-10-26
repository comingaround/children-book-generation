import type { Book, Box, Child, Page } from '../types';

const who = (child: Child) => `${child.name}, a ${child.age ? `${child.age}-year-old ` : ''}${child.gender}`;

const notes = (child: Child) => (child.notes.trim() ? ` Notes about the child: ${child.notes.trim()}.` : '');

/** The box in words the model can follow; it reads the image, not our coordinates. */
function where(box: Box): string {
  const pct = (n: number) => `${Math.round(n)}%`;
  return `the area from ${pct(box.x)} to ${pct(box.x + box.w)} across and ${pct(box.y)} to ${pct(box.y + box.h)} down the image`;
}

/**
 * Step 1: draw the child once, in the book's style. Every page then copies this drawing,
 * which is what keeps the child looking the same from page to page.
 * Images: 1 = child photo, 2 = style page, 3 (optional) = crop of the original hero.
 */
export function characterPrompt(book: Book, child: Child, withHeroCrop: boolean): string {
  const s = book.settings;
  return [
    `Image 1 is a photo of a real child: ${who(child)}.${notes(child)}`,
    `Image 2 is an illustration from the children's picture book "${book.title}".${s.artStyle ? ` Its art style: ${s.artStyle}.` : ''}`,
    withHeroCrop ? "Image 3 shows the book's original hero. Use it only for the outfit and body proportions; do not copy their face or hair." : '',
    'Draw a character reference of the child from image 1 as a picture-book character, in exactly the art style of image 2: the same line work, colouring, shading, level of detail and body proportions as the characters in that book.',
    'Keep the child clearly recognisable: face shape, eyes, eyebrows, nose, hair colour, hair length and style, skin tone, and any glasses or other distinctive features from the photo.',
    s.protagonistDescription ? `Dress them like the book's hero: ${s.protagonistDescription}.` : "Dress them like the book's hero.",
    'One full-body figure, standing and facing the viewer in a relaxed neutral pose, on a plain warm off-white background. No other characters, no props, no text.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Step 2, per page: swap the hero for the approved character and leave everything else.
 * Images: 1 = page art, 2 = character reference, 3 = child photo.
 */
export function pagePrompt(book: Book, page: Page, child: Child): string {
  const s = book.settings;
  const hero = page.characterHint.trim() || s.protagonistDescription.trim() || "the book's main character";
  const genderSwap =
    s.protagonistGender !== child.gender
      ? ` The new hero is a ${child.gender} while the original was a ${s.protagonistGender}: change the face and hair accordingly, but keep the outfit and pose.`
      : '';
  return [
    `Image 1 is a page illustration from the children's picture book "${book.title}". Image 2 is the reference drawing of the new hero, ${who(child)}. Image 3 is a photo of that child, for likeness only.`,
    `Edit image 1: replace the book's hero — ${hero}${page.box ? `, in ${where(page.box)}` : ''} — with the new hero from image 2. Match image 2's face, hair colour, hair length and style, and skin tone.${genderSwap}`,
    "Keep the hero's pose, gesture, facial expression, clothing, position and size exactly as they are in image 1.",
    'Everything else must stay identical to image 1: the other characters, the background, objects, composition, framing, colours and art style. If the hero appears more than once, change every appearance.',
    page.kind === 'cover' ? 'Keep the book title lettering exactly as it is, letter for letter.' : 'Do not add any text, letters or signatures.',
    page.scenePrompt.trim() ? `About this scene: ${page.scenePrompt.trim()}` : '',
    'Return the whole illustration at the same framing as image 1.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- "Draft with AI" (cheap text model) -------------------------------------------

export interface PageDraft {
  hasProtagonist: boolean;
  characterHint: string;
  scenePrompt: string;
  /** [ymin, xmin, ymax, xmax] on a 0–1000 grid, Gemini's native box format. */
  box: number[] | null;
}

export const pageDraftSchema = {
  type: 'OBJECT',
  properties: {
    hasProtagonist: { type: 'BOOLEAN' },
    characterHint: { type: 'STRING' },
    scenePrompt: { type: 'STRING' },
    box: { type: 'ARRAY', items: { type: 'INTEGER' }, nullable: true },
  },
  required: ['hasProtagonist', 'characterHint', 'scenePrompt', 'box'],
};

export function pageDraftPrompt(book: Book, page: Page): string {
  const s = book.settings;
  const text = page.lines.map((l) => l.text).join(' ');
  return [
    `This is ${page.kind === 'cover' ? 'the cover' : `page ${page.index}`} of the children's picture book "${book.title}".`,
    s.protagonistName ? `The main character (the hero) is ${s.protagonistName}${s.protagonistDescription ? `: ${s.protagonistDescription}` : ''}.` : '',
    text ? `The page text: "${text}"` : '',
    'Answer in JSON:',
    '- hasProtagonist: is the hero visible in the illustration?',
    '- characterHint: one short phrase that picks the hero out from everyone else in THIS picture (clothing, hair, position), e.g. "the red-haired girl in a blue blazer sitting on the left". Empty if not visible.',
    '- scenePrompt: one or two sentences describing the scene: setting, what the hero is doing, other characters, mood. No art-style words.',
    '- box: the bounding box around the hero (the whole figure, all of them if shown more than once) as [ymin, xmin, ymax, xmax] on a 0–1000 grid. null if not visible.',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface BookDraft {
  artStyle: string;
  protagonistName: string;
  protagonistGender: 'boy' | 'girl';
  protagonistDescription: string;
}

export const bookDraftSchema = {
  type: 'OBJECT',
  properties: {
    artStyle: { type: 'STRING' },
    protagonistName: { type: 'STRING' },
    protagonistGender: { type: 'STRING', enum: ['boy', 'girl'] },
    protagonistDescription: { type: 'STRING' },
  },
  required: ['artStyle', 'protagonistName', 'protagonistGender', 'protagonistDescription'],
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
    '- protagonistName: the main character\'s first name exactly as written in the text.',
    "- protagonistGender: 'boy' or 'girl'.",
    "- protagonistDescription: the hero's look in one phrase: approximate age, hair, usual outfit, e.g. \"a 6-year-old boy with short brown hair, yellow T-shirt and blue jeans\".",
  ].join('\n');
}
