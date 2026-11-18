import { castOn, type Book, type BookCharacter, type Box, type Gender, type Page, type PersonFacts } from '../types';

const who = (person: PersonFacts) => `${person.name}, a ${person.age ? `${person.age}-year-old ` : ''}${person.gender}`;

const notes = (person: PersonFacts) => (person.notes.trim() ? ` Notes about them: ${person.notes.trim()}.` : '');

/** The box in words the model can follow; it reads the image, not our coordinates. */
function where(box: Box): string {
  const pct = (n: number) => `${Math.round(n)}%`;
  return `the area from ${pct(box.x)} to ${pct(box.x + box.w)} across and ${pct(box.y)} to ${pct(box.y + box.h)} down the image`;
}

/** What the character wears on this page: the page's own outfit, else their usual one. */
/**
 * What a character wears on a page, as noted for that page. No fallback to their usual outfit: a
 * page where they wear pyjamas once came out in the usual striped polo. Empty = only the picture says.
 */
export const clothingOn = (character: BookCharacter, page: Page) => castOn(page, character.id).clothing.trim();

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
export function characterPrompt(book: Book, character: BookCharacter, person: PersonFacts, withCrop: boolean): string {
  const s = book.settings;
  const clothing = character.clothing.trim();
  return [
    `Image 1 is a photo of a real person: ${who(person)}.${notes(person)} It is a reference for their looks only: do not edit it, do not draw over it, and keep nothing from it but the person's face, hair and features — not its background, scenery, light, other people or clothes.`,
    `Image 2 is an illustration from the picture book "${book.title}".${s.artStyle ? ` Its art style: ${s.artStyle}.` : ''}`,
    withCrop ? `Image 3 shows the book's original ${character.label}. Use it only for the outfit and body proportions; do not copy their face or hair.` : '',
    'Draw a character reference of the person from image 1 as a picture-book character, in exactly the art style of image 2: the same line work, colouring, shading, level of detail and body proportions as the characters in that book.',
    'Keep them clearly recognisable: face shape, eyes, eyebrows, nose, hair colour, hair length and style, skin tone, facial hair, and any glasses or other distinctive features from the photo.',
    FACE_CONVENTIONS,
    clothing ? `Dress them exactly in the book's outfit: ${clothing}.` : `Dress them like the book's ${character.label}.`,
    'Make a completely new picture: one full-body figure, standing and facing the viewer in a relaxed neutral pose, alone on a plain, flat, warm off-white background that fills the whole frame — no scenery, no photo, no trace of image 1 behind or around them. No other characters, no props, no text.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** One character being replaced on a page; `box` is their place in image 1. */
export interface PromptMember {
  character: BookCharacter;
  person: PersonFacts;
  box: Box | null;
  /** A correction meant only for this character. */
  fix: string | null;
}

/** What is said about one character in either framing. */
function characterFacts(page: Page, { character, person }: PromptMember) {
  const cast = castOn(page, character.id);
  return {
    target: cast.hint.trim() || character.description.trim() || `the book's ${character.label}`,
    clothing: clothingOn(character, page),
    pose: cast.pose.trim(),
    expression: cast.expression?.trim() ?? '',
    genderSwap:
      character.gender !== person.gender
        ? ` The new person is a ${person.gender} while the original was a ${character.gender}: change the face and hair accordingly, but keep the clothing and pose.`
        : '',
  };
}

/**
 * Where the new head goes. The model used to drift a head ~20 px sideways or lower, and squeeze
 * bigger new hair into the old hair's outline.
 */
const HEAD_PLACE =
  'Keep the head exactly where it is in image 1: the eyes, nose, mouth and chin at the same spot, the head the same size and at the same tilt. The new hair grows outward from that same head: never shrink, flatten or crop bigger, curlier or longer hair to fit the old hair’s outline, give it the room it needs.';

/** Objects the characters touch: the part of a box that isn't the person must not move. */
const keepObjectsLine = (page: Page) =>
  page.keepObjects?.trim()
    ? `These objects stay exactly as in image 1, with the same shape, outline, angle and position, as if untouched: ${page.keepObjects.trim()}. Hands that rest on them stay exactly where they are; only their skin tone changes.`
    : '';

/**
 * The face's mood comes from this page's own character: the person's drawing and photo smile
 * (character sheets and portraits), and that smile used to replace a focused or sleepy original.
 */
const expressionLine = (expression: string, refs: string) =>
  `Their facial expression comes only from image 1, this page's own character: where the eyes look, how open they are, the eyebrows and the mouth exactly as there${expression ? ` (${expression})` : ''}. ${refs} show who they are, not how they feel: ignore the smile and expression in them.`;

/**
 * Colour: a page once came back a little redder than the original. Every page prompt (and the
 * version edit) says the palette stays exactly the book's.
 */
const KEEP_COLOURS =
  'Keep the colours exactly as in image 1: the same hues, saturation, brightness, contrast, warmth and white balance everywhere, with no colour cast, tint, filter or extra glow. Clothing, objects, background and light keep their exact colours; the only colours that change are the new people’s skin, hair and eyes.';

const correction = (fix: string | null) => (fix ? `A correction for this version, which takes priority over anything above: ${fix}` : '');

/** The lines every page prompt ends with. */
const closingLines = (book: Book, page: Page, fix: string | null) => [
  styleLine(book),
  'Everything else must stay identical to image 1: every other character, the background, objects, composition, framing and colours. If a changed character appears more than once, change every appearance.',
  keepObjectsLine(page),
  KEEP_COLOURS,
  // Some books print their text into the art: a model once rewrote "Noah and Lina" there with a person's name.
  page.kind === 'cover'
    ? 'Keep any title lettering exactly as it is, letter for letter.'
    : 'Keep any text already in image 1 (speech bubbles, captions, signs) exactly as it is, letter for letter: never change a name in it. Do not add any new text, letters or signatures.',
  page.scenePrompt.trim() ? `About this scene: ${page.scenePrompt.trim()}` : '',
  correction(fix),
  'Return the whole image at exactly the same framing as image 1: do not zoom in or out, crop, reframe or move the camera. Every wall, floor, piece of furniture and object outside the people stays at the same position and size in the picture.',
];

/**
 * Step 2: give book characters the people's faces, hair and skin; keep their clothing, pose and
 * place. One member = one by one; several = all at once in a single call.
 * Images: 1 = page art (or a close-up of it), then per member the head of their approved
 * drawing and their photo, in order. `fix` is a correction for everyone on the page.
 */
export function pagePrompt(book: Book, page: Page, members: PromptMember[], closeUp: boolean, fix: string | null): string {
  const art = `${closeUp ? 'Image 1 is a close-up cut from a page illustration' : 'Image 1 is a page illustration'} of the picture book "${book.title}".`;

  if (members.length === 1) {
    const m = members[0];
    const f = characterFacts(page, m);
    return [
      `${art} Image 2 shows the head of ${who(m.person)}, drawn in this book's style. Image 3 is a photo of them, for likeness only.`,
      `Edit image 1: change only ${f.target}${m.box ? `, in ${where(m.box)}` : ''}. Give them the face, hair (colour, length and style), skin tone, facial hair and any glasses from image 2. Take nothing else from image 2.${f.genderSwap}`,
      `Keep their clothing exactly as drawn in image 1: the same garments, colours, patterns and finish.${f.clothing ? ` A note on it, if image 1 and the note disagree, image 1 wins: ${f.clothing}.` : ''}`,
      `Keep their pose and direction exactly as in image 1${f.pose ? `: ${f.pose}` : ''}. Same body position, which way they face, where they look, gestures, expression, size and place in the picture.`,
      HEAD_PLACE,
      expressionLine(f.expression, 'Images 2 and 3'),
      ...closingLines(book, page, [fix, m.fix].filter(Boolean).join('; ') || null),
    ]
      .filter(Boolean)
      .join('\n');
  }

  const blocks = members.map((m, i) => {
    const f = characterFacts(page, m);
    const head = 2 + i * 2;
    return [
      `Person ${i + 1}: ${f.target}${m.box ? `, in ${where(m.box)}` : ''}. Image ${head} shows the head of ${who(m.person)} drawn in this book's style; image ${head + 1} is their photo, for likeness only.`,
      `Give this character the face, hair (colour, length and style), skin tone, facial hair and any glasses from image ${head}, and nothing else from it.${f.genderSwap}`,
      `Keep their clothing exactly as drawn in image 1 (same garments, colours, patterns and finish${f.clothing ? `; a note, image 1 wins if they disagree: ${f.clothing}` : ''}) and their pose and direction${f.pose ? ` (${f.pose})` : ''} exactly as in image 1: same body position, which way they face, where they look, gestures, expression, size and place.`,
      HEAD_PLACE,
      expressionLine(f.expression, `Images ${head} and ${head + 1}`),
      m.fix ? `For this person only: ${m.fix}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  });
  return [
    `${art} Edit image 1: ${members.length} characters in it get the faces of real people. Each one gets ONLY their own person; never mix, swap or blend features between them.`,
    ...blocks,
    ...closingLines(book, page, fix),
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- "Prepare with AI" (cheap text model) -------------------------------------------

export interface CastDraft {
  id: string;
  present: boolean;
  hint: string;
  pose: string;
  clothing: string;
  expression: string;
  /** [ymin, xmin, ymax, xmax] on a 0–1000 grid, Gemini's native box format. */
  box: number[] | null;
}

export interface PageDraft {
  scenePrompt: string;
  cast: CastDraft[];
  /** Text printed in the picture: its words and [ymin, xmin, ymax, xmax] on a 0–1000 grid. */
  texts: { text: string; box: number[] }[];
  /** Objects the characters touch or overlap. */
  keepObjects: string;
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
          expression: { type: 'STRING' },
          box: { type: 'ARRAY', items: { type: 'INTEGER' }, nullable: true },
        },
        required: ['id', 'present', 'hint', 'pose', 'clothing', 'expression', 'box'],
      },
    },
    texts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { text: { type: 'STRING' }, box: { type: 'ARRAY', items: { type: 'INTEGER' } } },
        required: ['text', 'box'],
      },
    },
    keepObjects: { type: 'STRING' },
  },
  required: ['scenePrompt', 'cast', 'texts', 'keepObjects'],
};

export function pageDraftPrompt(book: Book, page: Page): string {
  const text = page.lines.map((l) => l.text).join(' ');
  const characters = book.characters
    // Who they are, not what they usually wear: that pulled each page's clothing read towards it.
    .map((c) => `- id "${c.id}": ${c.label}${c.description ? `, ${c.description}` : ''}`)
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
    '  - clothing: exactly what they wear in THIS picture, judged only from this picture, never from other pages: each visible garment with its exact colour (e.g. off-white, not light blue, when it is off-white), its pattern ("plain" when there is none) and fabric. Empty if not visible.',
    '  - expression: their facial expression in THIS picture only, judged from this picture alone: where the eyes look, how open they are, the eyebrows, and the mouth (closed, a soft smile, a wide smile, open, pouting), e.g. "focused, eyes down on the toy, mouth closed". Empty if the face is not visible.',
    '  - box: the bounding box around them (the whole figure, all of them if shown more than once) as [ymin, xmin, ymax, xmax] on a 0–1000 grid. null if not visible.',
    '- texts: every block of words printed in the image itself: story text in a speech bubble or caption panel, a title, words on a sign or book cover. One entry per block: text (its words, as printed) and box (around all its letters and its bubble or panel) as [ymin, xmin, ymax, xmax] on a 0–1000 grid. Many picture books print the story text inside the illustration, so look carefully. An empty list only if there are no words at all.',
    '- keepObjects: the objects a character touches, holds, sits on, leans on or overlaps in THIS picture, each named so it can be found and with what touches it, e.g. "the toy castle under the boy’s hands, the stool he sits on, the teacup in the girl’s hand". Empty if none.',
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

// ---- he/she in the page text ----------------------------------------------------------------

export interface TextChange {
  /** The person's name, already in the text. */
  name: string;
  from: Gender;
  to: Gender;
}

export interface TextRewrite {
  pages: { page: number; lines: string[] }[];
}

export const textRewriteSchema = {
  type: 'OBJECT',
  properties: {
    pages: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { page: { type: 'INTEGER' }, lines: { type: 'ARRAY', items: { type: 'STRING' } } },
        required: ['page', 'lines'],
      },
    },
  },
  required: ['pages'],
};

/** Rewrites the words about characters whose gender changed; everything else stays word for word. */
export function textRewritePrompt(pages: { page: number; lines: string[] }[], changes: TextChange[]): string {
  const who = changes.map((c) => `- ${c.name}: was written as a ${c.from}, is now a ${c.to}`).join('\n');
  return `This is the text of a children's picture book, page by page and line by line. Some characters are now played by someone of the other gender:
${who}

Change only the words that refer to these characters: pronouns (he/she, him/her, his/her/hers, himself/herself) and gendered nouns (boy/girl, son/daughter, brother/sister, man/woman, daddy/mommy, mister/miss, king/queen and the like). Use context to tell who a pronoun refers to; words about anyone else stay as they are.
Keep every other word, the punctuation, the capitalisation and the line breaks exactly. Return every page given, with exactly as many lines as it has now, each new line as close to the old one as possible.

${JSON.stringify(pages)}`;
}

/**
 * "Edit this version": image 1 is a version already made (faces done, poses right), image 2 the
 * book's own art of the same part of the page. Only what the owner asks changes — by default the
 * clothing, back to the colours, fabric and finish of the original.
 */
export function touchUpPrompt(book: Book, page: Page, characters: BookCharacter[], fix: string | null): string {
  const outfits = characters.map((c) => `- ${c.label}: ${clothingOn(c, page) || 'as in image 2'}`).join('\n');
  return [
    `Image 1 is a finished illustration from the picture book "${book.title}". Image 2 is the same part of the page exactly as the book's illustrator drew it.`,
    fix
      ? `Edit image 1 only as follows: ${fix}`
      : 'Edit image 1: repaint only the clothing so its colours, fabric, pattern and finish match image 2 exactly: the same hue, lightness and softness, painted with the same flat, matte brushwork, no extra gloss, sheen or highlights.',
    `What each character wears here:\n${outfits}`,
    'Change nothing else in image 1: keep every face, hairstyle, skin tone, glasses, expression, pose, hand, the background, objects, light and colours exactly as they are, pixel for pixel where possible. Do not copy any face or hair from image 2.',
    'Keep any text in image 1 exactly as it is, letter for letter. Do not add any text.',
    'Return the whole image at the same framing as image 1.',
  ].join('\n');
}
