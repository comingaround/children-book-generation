import type { Book, BookCharacter, CastStep, PageCast, Person, Run, RunStep } from './types';

/**
 * Files written before books had a cast of several characters had one "protagonist" in the
 * book settings and on each page. These read those files into the current shapes; the new
 * shape is written back on the next save.
 */

/** The id the single old main character becomes. */
const MAIN = 'c1';

type Legacy = Record<string, unknown>;

export function migrateBook(raw: Book): Book {
  if (Array.isArray(raw.characters)) return raw;
  const old = raw.settings as unknown as Legacy;
  const main: BookCharacter = {
    id: MAIN,
    label: String(old.protagonistName || 'Main character'),
    nameInText: String(old.protagonistName ?? ''),
    gender: (old.protagonistGender as BookCharacter['gender']) ?? 'boy',
    description: String(old.protagonistDescription ?? ''),
    clothing: String(old.clothing ?? ''),
  };
  return {
    ...raw,
    characters: [main],
    settings: {
      artStyle: String(old.artStyle ?? ''),
      keepOutsideBox: old.keepOutsideBox !== false,
      textHalo: !!old.textHalo,
      ...(old.closeUp === false ? { closeUp: false } : {}),
    },
    pages: raw.pages.map((page) => {
      const p = page as unknown as Legacy;
      const cast: PageCast = {
        present: !!p.hasProtagonist && page.kind !== 'skip',
        box: (p.box as PageCast['box']) ?? null,
        hint: String(p.characterHint ?? ''),
        pose: String(p.pose ?? ''),
        clothing: String(p.clothing ?? ''),
      };
      const { index, kind, image, thumb, imageWidth, imageHeight, imageRect, scenePrompt, lines } = page;
      const pageCast: Record<string, PageCast> = cast.present || cast.box ? { [MAIN]: cast } : {};
      return { index, kind, image, thumb, imageWidth, imageHeight, imageRect, scenePrompt, lines, cast: pageCast };
    }),
  };
}

export function migratePerson(raw: Person): Person {
  if (raw.drawings) return raw;
  const old = (raw as unknown as Legacy).characters as Record<string, string> | undefined;
  const { characters: _old, ...rest } = raw as Person & { characters?: unknown };
  void _old;
  return { ...rest, drawings: Object.fromEntries(Object.entries(old ?? {}).map(([bookId, file]) => [`${bookId}/${MAIN}`, file])) };
}

export function migrateRun(raw: Run): Run {
  if (Array.isArray(raw.cast)) return raw;
  const old = raw as unknown as Legacy & { character: RunStep & { approved: boolean; reused: boolean }; childId: string };
  const step: CastStep = { ...old.character, characterId: MAIN, personId: old.childId };
  const { character: _c, childId: _p, ...rest } = old;
  void _c;
  void _p;
  return { ...(rest as unknown as Run), cast: [step] };
}
