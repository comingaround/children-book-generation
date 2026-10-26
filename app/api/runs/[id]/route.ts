import { HttpError, respond } from '@/lib/http-error';
import { resumeIfIdle, setTogether } from '@/lib/runner';
import { deleteRun, requireRun } from '@/lib/store';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return respond('run', { status: 500, message: 'Could not load the run' }, async () =>
    Response.json(await resumeIfIdle(await requireRun((await params).id)))
  );
}

/** `{ together }`: how pages made from now on draw their characters (one call each, or all at once). */
export async function PATCH(req: Request, { params }: Ctx) {
  return respond('run:update', { status: 500, message: 'Could not save' }, async () => {
    const { together } = (await req.json()) as { together?: boolean };
    if (typeof together !== 'boolean') throw new HttpError(400, 'Nothing to change');
    return Response.json(await setTogether((await params).id, together));
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return respond('run:delete', { status: 500, message: 'Could not delete the run' }, async () => {
    await deleteRun((await requireRun((await params).id)).id);
    return Response.json({ ok: true });
  });
}
