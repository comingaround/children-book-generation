import { rm } from 'node:fs/promises';

import { respond } from '@/lib/http-error';
import { readPersonForm } from '@/lib/person-form';
import { dataPath, deletePerson, requirePerson, savePerson } from '@/lib/store';

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return respond('people:update', { status: 500, message: 'Could not save the person' }, async () => {
    const person = await readPersonForm(await req.formData(), await requirePerson((await params).id));
    await savePerson(person);
    return Response.json(person);
  });
}

/** `?photo=1` removes only the photo and the drawings made from it; otherwise the whole profile. */
export async function DELETE(req: Request, { params }: Ctx) {
  return respond('people:delete', { status: 500, message: 'Could not delete' }, async () => {
    const person = await requirePerson((await params).id);
    if (new URL(req.url).searchParams.get('photo') !== '1') {
      await deletePerson(person.id);
      return Response.json({ ok: true });
    }
    if (person.photo) await rm(dataPath(person.photo), { force: true });
    await rm(dataPath('children', person.id, 'characters'), { recursive: true, force: true });
    const updated = { ...person, photo: null, drawings: {} };
    await savePerson(updated);
    return Response.json(updated);
  });
}
