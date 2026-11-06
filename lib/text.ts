import type { TextChange } from './ai/prompts';
import { swapName } from './client';
import { isMale, type Book, type Gender } from './types';

/** One person in a run, as the text rewrite needs them. */
export interface TextCast {
  characterId: string;
  name: string;
  gender: Gender;
}

/**
 * Name swaps, and the characters now played by someone of the other gender (a girl as Ross).
 * No changes = the pages only need the names swapped, no rewrite.
 */
export function textChanges(book: Book, cast: TextCast[]): { names: [string, string][]; changes: TextChange[] } {
  const names: [string, string][] = [];
  const changes: TextChange[] = [];
  for (const step of cast) {
    const character = book.characters.find((c) => c.id === step.characterId);
    if (!character) continue;
    const inText = character.nameInText.trim();
    if (inText) names.push([inText, step.name]);
    if (isMale(character.gender) !== isMale(step.gender)) changes.push({ name: inText ? step.name : character.label, from: character.gender, to: step.gender });
  }
  return { names, changes };
}

export const swapNames = (text: string, names: [string, string][]) => names.reduce((t, [from, to]) => swapName(t, from, to), text);
