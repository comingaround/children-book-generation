import { rm } from 'node:fs/promises';

import { readChildForm } from '@/lib/child-form';
import { respond } from '@/lib/http-error';
import { dataPath, deleteChild, requireChild, saveChild } from '@/lib/store';

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return respond('children:update', { status: 500, message: 'Could not save the child' }, async () => {
    const child = await readChildForm(await req.formData(), await requireChild((await params).id));
    await saveChild(child);
    return Response.json(child);
  });
}

/** `?photo=1` removes only the photo and the drawings made from it; otherwise the whole profile. */
export async function DELETE(req: Request, { params }: Ctx) {
  return respond('children:delete', { status: 500, message: 'Could not delete' }, async () => {
    const child = await requireChild((await params).id);
    if (new URL(req.url).searchParams.get('photo') !== '1') {
      await deleteChild(child.id);
      return Response.json({ ok: true });
    }
    if (child.photo) await rm(dataPath(child.photo), { force: true });
    await rm(dataPath('children', child.id, 'characters'), { recursive: true, force: true });
    const updated = { ...child, photo: null, characters: {} };
    await saveChild(updated);
    return Response.json(updated);
  });
}
