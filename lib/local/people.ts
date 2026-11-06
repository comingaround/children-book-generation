import { GENDERS, type Gender, type Person } from '../types';
import { deleteFile, localKey, saveFile } from './files';
import { newId, requirePerson, savePerson } from './store';

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const PHOTO_MAX = 2048;

export interface PersonFields {
  name: string;
  gender: Gender;
  /** As typed: digits or empty. */
  age: string;
  notes: string;
}

/** A photo stored upright, at most 2048 px, as a JPEG on white. */
async function normalizePhoto(file: File): Promise<Blob> {
  if (file.size > MAX_PHOTO_BYTES) throw new Error('That photo is over 15 MB');
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('That image could not be read');
  });
  const scale = Math.min(1, PHOTO_MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('That image could not be read'))), 'image/jpeg', 0.9));
}

/** Checks the form's fields and applies them; a new photo replaces the old one and its drawings. */
async function apply(person: Person, fields: PersonFields, photo: File | null): Promise<Person> {
  const name = fields.name.trim();
  if (!name) throw new Error('Enter a name');
  if (!GENDERS.some((g) => g.value === fields.gender)) throw new Error('Choose boy, girl, man or woman');
  const age = fields.age === '' ? null : Math.round(Number(fields.age));
  if (age !== null && !(age >= 0 && age <= 110)) throw new Error('Enter a real age');

  const next: Person = { ...person, name, gender: fields.gender, age, notes: fields.notes.trim() };
  if (photo) {
    const blob = await normalizePhoto(photo);
    next.photo = await saveFile(localKey(`children/${person.id}/photo-${Date.now().toString(36)}.jpg`), blob);
    // A new face makes the saved drawings stale.
    await deleteFile(person.photo);
    for (const file of Object.values(person.drawings)) await deleteFile(file);
    next.drawings = {};
  }
  return next;
}

export async function createPerson(fields: PersonFields, photo: File | null, consent: boolean): Promise<Person> {
  if (!consent) throw new Error('Confirm that you may use this photo');
  if (!photo) throw new Error('Add a photo');
  const createdAt = new Date().toISOString();
  const blank: Person = { id: newId('person'), name: '', gender: 'boy', age: null, notes: '', photo: null, createdAt, consentAt: createdAt, drawings: {} };
  return savePerson(await apply(blank, fields, photo));
}

export async function updatePerson(id: string, fields: PersonFields, photo: File | null): Promise<Person> {
  return savePerson(await apply(await requirePerson(id), fields, photo));
}
