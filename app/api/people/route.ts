import { HttpError, respond } from '@/lib/http-error';
import { readPersonForm } from '@/lib/person-form';
import { listPeople, newId, savePerson } from '@/lib/store';
import type { Person } from '@/lib/types';

export async function GET() {
  return respond('people', { status: 500, message: 'Could not list people' }, async () => Response.json(await listPeople()));
}

export async function POST(req: Request) {
  return respond('people:create', { status: 500, message: 'Could not save the person' }, async () => {
    const blank: Person = { id: newId('child'), name: '', gender: 'boy', age: null, notes: '', photo: null, createdAt: new Date().toISOString(), drawings: {} };
    const person = await readPersonForm(await req.formData(), blank);
    if (!person.photo) throw new HttpError(400, 'Add a photo');
    await savePerson(person);
    return Response.json(person);
  });
}
