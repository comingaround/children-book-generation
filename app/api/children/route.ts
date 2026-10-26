import { HttpError, respond } from '@/lib/http-error';
import { readChildForm } from '@/lib/child-form';
import { listChildren, newId, saveChild } from '@/lib/store';
import type { Child } from '@/lib/types';

export async function GET() {
  return respond('children', { status: 500, message: 'Could not list children' }, async () => Response.json(await listChildren()));
}

export async function POST(req: Request) {
  return respond('children:create', { status: 500, message: 'Could not save the child' }, async () => {
    const blank: Child = { id: newId('child'), name: '', gender: 'boy', age: null, notes: '', photo: null, createdAt: new Date().toISOString(), characters: {} };
    const child = await readChildForm(await req.formData(), blank);
    if (!child.photo) throw new HttpError(400, 'Add a photo of the child');
    await saveChild(child);
    return Response.json(child);
  });
}
