import { api } from '../client';
import { chosenFile, personFacts, type Book, type Example, type Person, type Run } from '../types';
import { readFile } from './files';

/**
 * Sends a finished run to app/api/examples (the owner, on the local version): the version each
 * step shows and each person's photo. The server keeps them with the site as an example.
 */
export async function publishExample(book: Book, run: Run, people: Person[]): Promise<Example> {
  const form = new FormData();
  for (const step of [...run.cast, ...Object.values(run.pages)]) {
    const file = chosenFile(step);
    if (file) form.set(`file:${file}`, await readFile(file));
  }
  const cast = [];
  for (const step of run.cast) {
    const person = people.find((p) => p.id === step.personId);
    if (!person?.photo) throw new Error('Every person in the run needs their photo');
    form.set(`photo:${step.characterId}`, await readFile(person.photo));
    cast.push({ characterId: step.characterId, ...personFacts(person) });
  }
  form.set('spec', JSON.stringify({ run, cast }));
  return api<Example>('/api/examples', { method: 'POST', body: form });
}
