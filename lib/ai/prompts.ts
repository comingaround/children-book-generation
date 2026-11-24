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
  /** Their hairstyle in words, from the hair study of their drawing (hairStudyPrompt). */
  hair?: string;
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

/**
 * The hairstyle is the person's, from their approved drawing, the same on every page. Pages named
 * the original's bun ("the woman with a high bun") and Mama kept a bun on some pages and loose hair
 * on others (Noah & Lina, 19 Nov).
 */
const hairLine = (ref: string, hair?: string) =>
  `Their hairstyle comes only from ${ref}${hair ? ` (${hair})` : ''}: the same length, parting and fringe, loose or tied exactly as there, as on every other page, also when seen from the side or from behind. Ignore the original character's hairstyle completely (a bun, ponytail or pigtails in image 1 or in any description only helps find them): replace it, never tie up loose hair or untie tied hair.`;

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

const correction = (fix: string | null) => (fix ? `A correction for this version, which takes priority over anything above: ${fix}` : '');

/** The lines every page prompt ends with. */
const closingLines = (book: Book, page: Page, fix: string | null) => [
  styleLine(book),
  'Everything else must stay identical to image 1: every other character, the background, objects, composition, framing and colours. If a changed character appears more than once, change every appearance.',
  keepObjectsLine(page),
  // Faded pages (Noah & Lina's "The End"). "As pale as the original" alone came back too strong;
  // naming what to wash out (hair, glasses, skin, no deep black or red) matched the book in one
  // answer (12 Nov run). Whatever is still stronger is softened afterwards (images.ts softenToOriginal).
  page.seeThrough
    ? "The characters in image 1 are drawn faded and see-through, in a milky, washed-out palette. Draw every character you change the same way, exactly as faded as the original characters, area by area: washed-out hair, glasses, skin and clothes, no deep black and no strong red anywhere on them, the background and border showing through their bodies and legs as much as in image 1. Each person keeps their own skin tone and hair colour, only as faded as the original's."
    : '',
  // Some books print their text into the art: a model once rewrote "Noah and Lina" there with a person's name.
  page.kind === 'cover'
    ? 'Keep any title lettering exactly as it is, letter for letter.'
    : 'Keep any text already in image 1 (speech bubbles, captions, signs) exactly as it is, letter for letter: never change a name in it. Do not add any new text, letters or signatures.',
  page.scenePrompt.trim() ? `About this scene: ${page.scenePrompt.trim()}` : '',
  correction(fix),
  // The model sometimes redrew the scene or moved the people (Noah & Lina cover, Pages 2 and 4).
  'Return the whole image at exactly the same framing as image 1: do not zoom in or out, crop, reframe or move the camera. Every wall, floor, piece of furniture and object stays at the same position and size, and every character keeps their exact place, size and pose.',
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
      hairLine('image 2', m.hair),
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
      hairLine(`image ${head}`, m.hair),
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
  /** How see-through the characters are drawn, 0–90 percent. */
  seeThrough: number;
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
    seeThrough: { type: 'INTEGER' },
  },
  required: ['scenePrompt', 'cast', 'texts', 'keepObjects', 'seeThrough'],
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
    '  - hint: one short phrase that picks them out from everyone else in THIS picture (clothing and position only, never hair or face: those are replaced), e.g. "the girl in a blue blazer sitting on the left". Empty if not visible.',
    '  - pose: their pose and direction in one short phrase. Always start by saying what the viewer sees of them: their face (facing the viewer), their back, their profile (facing left or right), or a three-quarter view. Then the body position, where they look and what the hands do. Empty if not visible.',
    '  - clothing: exactly what they wear in THIS picture, judged only from this picture, never from other pages: each visible garment with its exact colour (e.g. off-white, not light blue, when it is off-white), its pattern ("plain" when there is none) and fabric. Empty if not visible.',
    '  - expression: their facial expression in THIS picture only, judged from this picture alone: where the eyes look, how open they are, the eyebrows, and the mouth (closed, a soft smile, a wide smile, open, pouting), e.g. "focused, eyes down on the toy, mouth closed". Empty if the face is not visible.',
    '  - box: the bounding box around them (the whole figure, all of them if shown more than once) as [ymin, xmin, ymax, xmax] on a 0–1000 grid. null if not visible.',
    '- texts: every block of words printed in the image itself: story text in a speech bubble or caption panel, a title, words on a sign or book cover. One entry per block: text (its words, as printed) and box (around all its letters and its bubble or panel) as [ymin, xmin, ymax, xmax] on a 0–1000 grid. Many picture books print the story text inside the illustration, so look carefully. An empty list only if there are no words at all.',
    '- keepObjects: the objects a character touches, holds, sits on, leans on or overlaps in THIS picture, each named so it can be found and with what touches it, e.g. "the toy castle under the boy’s hands, the stool he sits on, the teacup in the girl’s hand". Empty if none.',
    '- seeThrough: how see-through the characters are drawn, in percent: 0 when they are solid like ordinary picture-book figures (almost every page). Above 0 only when the background, a border or the paper clearly shows through their bodies, as in a faded memory or a ghostly ending page: e.g. 35 when they look about two-thirds solid. At most 90.',
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

// ---- the hair of an approved drawing --------------------------------------------------------

/** What the text model reads off a person's approved drawing, once (draw.ts hairOf). */
export interface HairStudy {
  hair: string;
  /** Where the lowest hair ends, 0–1000 of the drawing's height from the top. */
  bottom: number;
  volume: 'close' | 'medium' | 'big';
  reach: 'above-chin' | 'shoulders' | 'below-shoulders';
}

export const hairStudyPrompt = [
  'This is a character drawing of one person, standing, on a plain background.',
  'Describe only their hair, for an illustrator who must draw exactly this hairstyle on every page of a book, also from the side and from behind:',
  '- hair: one sentence: colour, texture (straight, wavy, curly, coily), length (where it ends: ears, chin, shoulders, chest, waist), loose or tied and exactly how (a ponytail and where it falls, over which shoulder; a bun; braids; clips), parting and fringe. Nothing about the face or clothes.',
  '- bottom: the lowest point any hair reaches, as a number from 0 (top of the image) to 1000 (bottom).',
  '- volume: "close" if the hair lies close to the head (short, cropped, slicked), "medium" for ordinary volume, "big" for voluminous, wide curls or an afro.',
  '- reach: "above-chin" if no hair falls below the chin, "shoulders" if it falls to the shoulders, "below-shoulders" if it falls lower.',
].join('\n');

// ---- checks on a page answer (lib/inspect.ts) --------------------------------------------

const faceLine =
  'face: the face only, from the top of the forehead to the chin and from ear to ear, without any hair, as [ymin, xmin, ymax, xmax] from 0 to 1000 of image 1. faceVisible: false if the face cannot be seen (the person is seen from behind) or there is no person.';

/** The faces in the book's own art: image 1 with numbered red boxes. */
export const faceOnOriginalPrompt = (count: number) =>
  [`Image 1 is a picture-book page with ${count} numbered red boxes, each around one person.`, 'For each box (box: its number), the person it outlines:', `- ${faceLine}`].join('\n');

export interface FaceAnswer {
  people: { box: number; faceVisible: boolean; face: number[] }[];
}

const faceProps = { faceVisible: { type: 'BOOLEAN' }, face: { type: 'ARRAY', items: { type: 'NUMBER' } } };

export const faceSchema = {
  type: 'OBJECT',
  properties: { people: { type: 'ARRAY', items: { type: 'OBJECT', properties: { box: { type: 'INTEGER' }, ...faceProps }, required: ['box', 'faceVisible', 'face'] } } },
  required: ['people'],
};

/** A page answer: image 1 with numbered red boxes; images 2.. are the people's approved drawings. */
export const inspectPrompt = (count: number, hairs: (string | undefined)[] = []) =>
  [
    `Image 1 is a picture-book page with ${count} numbered red boxes, each around one person. Images 2 to ${count + 1} are character drawings: the person who should be in box 1 is drawn in image 2, box 2 in image 3, and so on.`,
    ...hairs.flatMap((h, i) => (h ? [`The hair of the person in image ${i + 2}, as drawn: ${h}`] : [])),
    'For each box (box: its number), the person it outlines:',
    '- who: the number of the drawing (2 or more) this person is, judged by face, hair, skin and glasses, not by clothes; 0 if they match none.',
    // Lenient on purpose (owner, 24 Nov): the person's own hair worn up, down, over a shoulder or
    // tied is fine (Mama's curls in a bun or a low ponytail passed review); only hair the person
    // doesn't have counts, like the original girl's pigtails left on Mei (page 3).
    "- extraHair: hair on this person that is not their own hair: a separate ponytail, pigtails or braid of a different colour or style from their drawing's hair, left over from someone else (for example short-bob hair with pigtails sticking out behind). Their own hair worn differently never counts: up in a bun, down, over a shoulder, behind the back, or tied in a ponytail with a hair tie, band or clip. One short phrase, or an empty string if nothing.",
    `- ${faceLine}`,
  ].join('\n');

export interface InspectAnswer {
  people: { box: number; who: number; extraHair: string; faceVisible: boolean; face: number[] }[];
}

export const inspectSchema = {
  type: 'OBJECT',
  properties: {
    people: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { box: { type: 'INTEGER' }, who: { type: 'INTEGER' }, extraHair: { type: 'STRING' }, ...faceProps }, required: ['box', 'who', 'extraHair', 'faceVisible', 'face'] },
    },
  },
  required: ['people'],
};

export const hairStudySchema = {
  type: 'OBJECT',
  properties: {
    hair: { type: 'STRING' },
    bottom: { type: 'NUMBER' },
    volume: { type: 'STRING', enum: ['close', 'medium', 'big'] },
    reach: { type: 'STRING', enum: ['above-chin', 'shoulders', 'below-shoulders'] },
  },
  required: ['hair', 'bottom', 'volume', 'reach'],
};

/**
 * The same picture with some people taken out: what lies behind them, so a see-through page's
 * new people can be faded over it (lib/draw.ts). Image 1 = the drawn page (or its close-up).
 */
export function platePrompt(hints: string[], closeUp: boolean): string {
  return [
    `Image 1 is ${closeUp ? 'a close-up cut from a picture-book page' : 'a picture-book page'}.`,
    `Remove ${hints.length > 1 ? 'these characters' : 'this character'} completely, together with everything they hold or wear: ${hints.join('; ')}.`,
    'Paint what is behind them in their place: continue the background, the paper, any border, frame or pattern exactly as it runs around them, as if they had never been there.',
    'Everything else stays identical to image 1, at the same position, size and colour: every other character, object and line. Keep any lettering exactly as it is, also where it crossed the removed characters: finish the letters that were hidden behind them.',
    'Return the whole image at exactly the same framing as image 1: no zoom, crop or reframing, no new objects and no new text.',
  ].join('\n');
}
