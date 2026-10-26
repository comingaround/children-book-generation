import 'server-only';

import { HttpError } from './http-error';
import { forModel } from './images';
import { writeFileIn } from './store';
import { GENDERS, type Gender, type Person } from './types';

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** Applies the person form's fields to `person`. A new photo is stored upright, at most 2048 px. */
export async function readPersonForm(form: FormData, person: Person): Promise<Person> {
  const name = String(form.get('name') ?? person.name).trim();
  if (!name) throw new HttpError(400, 'Enter a name');
  const gender = String(form.get('gender') ?? person.gender) as Gender;
  if (!GENDERS.some((g) => g.value === gender)) throw new HttpError(400, 'Choose boy, girl, man or woman');
  const ageRaw = form.get('age');
  const age = ageRaw === null ? person.age : ageRaw === '' ? null : Math.round(Number(ageRaw));
  if (age !== null && !(age >= 0 && age <= 110)) throw new HttpError(400, 'Enter a real age');

  const next: Person = { ...person, name, gender, age, notes: String(form.get('notes') ?? person.notes).trim() };
  const photo = form.get('photo');
  if (photo instanceof File && photo.size > 0) {
    if (photo.size > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is over 15 MB');
    if (!photo.type.startsWith('image/')) throw new HttpError(400, 'Choose an image file');
    const { data } = await forModel(Buffer.from(await photo.arrayBuffer())).catch(() => {
      throw new HttpError(400, 'That image could not be read');
    });
    next.photo = await writeFileIn(`children/${person.id}/photo-${Date.now().toString(36)}.jpg`, data);
    // A new face makes the saved drawings stale.
    next.drawings = {};
  }
  return next;
}
