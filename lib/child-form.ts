import 'server-only';

import { HttpError } from './http-error';
import { forModel } from './images';
import { writeFileIn } from './store';
import type { Child, Gender } from './types';

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** Applies the child form's fields to `child`. A new photo is stored upright, at most 2048 px. */
export async function readChildForm(form: FormData, child: Child): Promise<Child> {
  const name = String(form.get('name') ?? child.name).trim();
  if (!name) throw new HttpError(400, "Enter the child's name");
  const gender = String(form.get('gender') ?? child.gender) as Gender;
  if (gender !== 'boy' && gender !== 'girl') throw new HttpError(400, 'Choose boy or girl');
  const ageRaw = form.get('age');
  const age = ageRaw === null ? child.age : ageRaw === '' ? null : Math.round(Number(ageRaw));
  if (age !== null && !(age >= 0 && age <= 18)) throw new HttpError(400, 'Age must be between 0 and 18');

  const next: Child = { ...child, name, gender, age, notes: String(form.get('notes') ?? child.notes).trim() };
  const photo = form.get('photo');
  if (photo instanceof File && photo.size > 0) {
    if (photo.size > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is over 15 MB');
    if (!photo.type.startsWith('image/')) throw new HttpError(400, 'Choose an image file');
    const { data } = await forModel(Buffer.from(await photo.arrayBuffer())).catch(() => {
      throw new HttpError(400, 'That image could not be read');
    });
    next.photo = await writeFileIn(`children/${child.id}/photo-${Date.now().toString(36)}.jpg`, data);
    // A new face makes the saved drawings stale.
    next.characters = {};
  }
  return next;
}
