import { castOn, type Book, type BookCharacter, type Box, type Gender, type Page, type Person } from '../types';

const who = (person: Person) => `${person.name}, a ${person.age ? `${person.age}-year-old ` : ''}${person.gender}`;

const notes = (person: Person) => (person.notes.trim() ? ` Notes about them: ${person.notes.trim()}.` : '');

/** The box in words the model can follow; it reads the image, not our coordinates. */
function where(box: Box): string {
  const pct = (n: number) => `${Math.round(n)}%`;
  return `the area from ${pct(box.x)} to ${pct(box.x + box.w)} across and ${pct(box.y)} to ${pct(box.y + box.h)} down the image`;
}

/** What the character wears on this page: the page's own outfit, else their usual one. */
export const clothingOn = (character: BookCharacter, page: Page) => castOn(page, character.id).clothing.trim() || character.clothing.trim();

/** Book faces are simpler than real ones; without this the likeness pulls the face towards realism. */
const FACE_CONVENTIONS =
  "Draw the face with the book's own conventions: eyes, nose and mouth as simple as on the other characters, the same amount of detail, no realistic skin texture, wrinkles or digital shading. Likeness comes from hair, face shape, skin tone and features, not from detail.";

const styleLine = (book: Book) =>
  `Draw in exactly the art style of the book${book.settings.artStyle.trim() ? ` (${book.settings.artStyle.trim()})` : ''}: the same line weight, colouring, shading, texture and level of detail as the rest of image 1, so the new person looks drawn by the same illustrator. ${FACE_CONVENTIONS}`;

/**
 * Step 1: draw the person once, in the book's style. Pages then take only the head of this
 * drawing (face, hair, skin), which keeps them the same on every page.
 * Images: 1 = photo, 2 = style page, 3 (optional) = crop of the original character.
 */
export function characterPrompt(book: Book, character: BookCharacter, person: Person, withCrop: boolean): string {
  const s = book.settings;
  const clothing = character.clothing.trim();
  return [
    `Image 1 is a photo of a real person: ${who(person)}.${notes(person)}`,
    `Image 2 is an illustration from the picture book "${book.title}".${s.artStyle ? ` Its art style: ${s.artStyle}.` : ''}`,
    withCrop ? `Image 3 shows the book's original ${character.label}. Use it only for the outfit and body proportions; do not copy their face or hair.` : '',
    'Draw a character reference of the person from image 1 as a picture-book character, in exactly the art style of image 2: the same line work, colouring, shading, level of detail and body proportions as the characters in that book.',
    'Keep them clearly recognisable: face shape, eyes, eyebrows, nose, hair colour, hair length and style, skin tone, facial hair, and any glasses or other distinctive features from the photo.',
    FACE_CONVENTIONS,
    clothing ? `Dress them exactly in the book's outfit: ${clothing}.` : `Dress them like the book's ${character.label}.`,
    'One full-body figure, standing and facing the viewer in a relaxed neutral pose, on a plain warm off-white background. No other characters, no props, no text.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Step 2, per character on a page: give the book's character the person's face, hair and skin;
 * keep their clothing, pose and place. Images: 1 = page art (or a close-up of it around the
 * character), 2 = head of the approved drawing, 3 = photo.
 * `box` is where the character is in image 1; for a close-up it's relative to the crop.
 */
export function pagePrompt(
  book: Book,
  page: Page,
  character: BookCharacter,
  person: Person,
  fix?: string | null,
  view: { closeUp: boolean; box: Box | null } = { closeUp: false, box: castOn(page, character.id).box }
): string {
  const cast = castOn(page, character.id);
  const target = cast.hint.trim() || character.description.trim() || `the book's ${character.label}`;
  const clothing = clothingOn(character, page);
  const pose = cast.pose.trim();
  const genderSwap =
    character.gender !== person.gender
      ? ` The new person is a ${person.gender} while the original was a ${character.gender}: change the face and hair accordingly, but keep the clothing and pose.`
      : '';
  return [
    `${view.closeUp ? 'Image 1 is a close-up cut from a page illustration' : 'Image 1 is a page illustration'} of the picture book "${book.title}". Image 2 shows the head of ${who(person)}, drawn in this book's style. Image 3 is a photo of them, for likeness only.`,
    `Edit image 1: change only ${target}${view.box ? `, in ${where(view.box)}` : ''}. Give them the face, hair (colour, length and style), skin tone, facial hair and any glasses from image 2. Take nothing else from image 2.${genderSwap}`,
    `Keep their clothing exactly as in image 1${clothing ? ` (${clothing})` : ''}: same garments, colours and patterns.`,
    `Keep their pose and direction exactly as in image 1${pose ? `: ${pose}` : ''}. Same body position, which way they face, where they look, gestures, expression, size and place in the picture.`,
    styleLine(book),
    'Everything else must stay identical to image 1: every other character, the background, objects, composition, framing and colours. If this character appears more than once, change every appearance.',
    page.kind === 'cover' ? 'Keep any title lettering exactly as it is, letter for letter.' : 'Do not add any text, letters or signatures.',
    page.scenePrompt.trim() ? `About this scene: ${page.scenePrompt.trim()}` : '',
    fix ? `A correction for this version, which takes priority over anything above: ${fix}` : '',
    'Return the whole image at the same framing as image 1.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- automatic check after each character (cheap text model) -------------------------

export interface PageCheck {
  samePose: boolean;
  sameClothing: boolean;
  sameStyle: boolean;
  looksLikePerson: boolean;
  restUnchanged: boolean;
  /** A short instruction for the next attempt; empty when all is well. */
  correction: string;
}

export const pageCheckSchema = {
  type: 'OBJECT',
  properties: {
    samePose: { type: 'BOOLEAN' },
    sameClothing: { type: 'BOOLEAN' },
    sameStyle: { type: 'BOOLEAN' },
    looksLikePerson: { type: 'BOOLEAN' },
    restUnchanged: { type: 'BOOLEAN' },
    correction: { type: 'STRING' },
  },
  required: ['samePose', 'sameClothing', 'sameStyle', 'looksLikePerson', 'restUnchanged', 'correction'],
};

export const checkPassed = (c: PageCheck) => c.samePose && c.sameClothing && c.sameStyle && c.looksLikePerson && c.restUnchanged;

/** Images: 1 = original (area around the character), 2 = the result, same area; 3 = the person's head as drawn. */
export function pageCheckPrompt(book: Book, page: Page, character: BookCharacter): string {
  const cast = castOn(page, character.id);
  const clothing = clothingOn(character, page);
  const pose = cast.pose.trim();
  return [
    `Image 1 is part of an original page from the picture book "${book.title}". Image 2 is the same part after one character (${cast.hint.trim() || character.description.trim() || character.label}) was redrawn as a different person, whose head is shown in image 3.`,
    'The redraw should change ONLY that character\'s face, hair (colour, length and style), skin tone, facial hair and glasses, to match image 3.',
    'Compare image 2 with image 1 and answer in JSON:',
    `- samePose: same pose and direction as in image 1${pose ? ` (${pose})` : ''}? Which way they face (face, back, profile), where they look, body position, gestures and expression must match. Small drawing differences are fine.`,
    `- sameClothing: same garments and colours as in image 1${clothing ? ` (${clothing})` : ''}?`,
    '- sameStyle: is the redrawn character in the same art style as the rest of image 2 (line weight, colouring, shading, texture), rather than looking pasted in or drawn by someone else?',
    '- looksLikePerson: do their face, hair and skin tone match image 3, rather than the original character?',
    '- restUnchanged: are the other characters, objects and background the same as in image 1?',
    '- correction: if anything above is false, ONE short instruction (under 100 characters) for the illustrator to fix it, naming what to match, e.g. "back to the viewer, like the original" or "softer watercolour shading like the rest of the page". Say "the original", never "image 1/2/3". Empty if everything is true.',
  ].join('\n');
}

// ---- "Prepare with AI" (cheap text model) -------------------------------------------

export interface CastDraft {
  id: string;
  present: boolean;
  hint: string;
  pose: string;
  clothing: string;
  /** True when the outfit on this page differs from the character's usual one. */
  clothingDiffers: boolean;
  /** [ymin, xmin, ymax, xmax] on a 0–1000 grid, Gemini's native box format. */
  box: number[] | null;
}

export interface PageDraft {
  scenePrompt: string;
  cast: CastDraft[];
}

export const pageDraftSchema = {
  type: 'OBJECT',
  properties: {
    scenePrompt: { type: 'STRING' },
    cast: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          present: { type: 'BOOLEAN' },
          hint: { type: 'STRING' },
          pose: { type: 'STRING' },
          clothing: { type: 'STRING' },
          clothingDiffers: { type: 'BOOLEAN' },
          box: { type: 'ARRAY', items: { type: 'INTEGER' }, nullable: true },
        },
        required: ['id', 'present', 'hint', 'pose', 'clothing', 'clothingDiffers', 'box'],
      },
    },
  },
  required: ['scenePrompt', 'cast'],
};

export function pageDraftPrompt(book: Book, page: Page): string {
  const text = page.lines.map((l) => l.text).join(' ');
  const characters = book.characters
    .map((c) => `- id "${c.id}": ${c.label}${c.description ? `, ${c.description}` : ''}${c.clothing ? `; usually wears ${c.clothing}` : ''}`)
    .join('\n');
  return [
    `This is ${page.kind === 'cover' ? 'the cover' : `page ${page.index}`} of the picture book "${book.title}".`,
    `The book's characters:\n${characters}`,
    text ? `The page text: "${text}"` : '',
    'Answer in JSON:',
    '- scenePrompt: one or two sentences describing the scene: setting, who is there and what they do, mood. No art-style words.',
    '- cast: one entry per character listed above, with its id:',
    '  - present: is this character visible in the illustration?',
    '  - hint: one short phrase that picks them out from everyone else in THIS picture (clothing, hair, position), e.g. "the red-haired girl in a blue blazer sitting on the left". Empty if not visible.',
    '  - pose: their pose and direction in one short phrase. Always start by saying what the viewer sees of them: their face (facing the viewer), their back, their profile (facing left or right), or a three-quarter view. Then the body position, where they look and what the hands do. Empty if not visible.',
    '  - clothing: what they wear on THIS page, garments and colours. Empty if not visible.',
    '  - clothingDiffers: true only if that outfit is clearly different from their usual outfit.',
    '  - box: the bounding box around them (the whole figure, all of them if shown more than once) as [ymin, xmin, ymax, xmax] on a 0–1000 grid. null if not visible.',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface CharacterDraft {
  label: string;
  nameInText: string;
  gender: Gender;
  description: string;
  clothing: string;
}

export interface BookDraft {
  artStyle: string;
  characters: CharacterDraft[];
}

export const bookDraftSchema = {
  type: 'OBJECT',
  properties: {
    artStyle: { type: 'STRING' },
    characters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          nameInText: { type: 'STRING' },
          gender: { type: 'STRING', enum: ['boy', 'girl', 'man', 'woman'] },
          description: { type: 'STRING' },
          clothing: { type: 'STRING' },
        },
        required: ['label', 'nameInText', 'gender', 'description', 'clothing'],
      },
    },
  },
  required: ['artStyle', 'characters'],
};

export function bookDraftPrompt(book: Book): string {
  const text = book.pages
    .filter((p) => p.kind !== 'skip')
    .flatMap((p) => p.lines.map((l) => l.text))
    .join(' ')
    .slice(0, 4000);
  return [
    `These are the cover and pages of the picture book "${book.title}". The book text: "${text}"`,
    'Answer in JSON:',
    '- artStyle: one sentence describing the illustration style (medium, line work, colouring, shading, texture), e.g. "soft watercolour with fine ink outlines and warm pastel washes".',
    '- characters: the people who appear repeatedly and could be replaced by real people (the main character first, then family members or friends; at most 5; no animals, no crowds). For each:',
    '  - label: how the book refers to them, e.g. "Ross" or "Mommy".',
    '  - nameInText: their name exactly as written in the text if they have one, else empty.',
    "  - gender: 'boy', 'girl', 'man' or 'woman'.",
    '  - description: how to recognise them, without clothing: approximate age, build and hair, e.g. "a 6-year-old boy with short brown hair".',
    '  - clothing: their usual outfit, garments and colours with any trim or pattern.',
  ].join('\n');
}
