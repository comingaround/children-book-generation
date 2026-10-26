import { respond } from '@/lib/http-error';
import { resumeIfIdle } from '@/lib/runner';
import { deleteRun, requireRun } from '@/lib/store';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return respond('run', { status: 500, message: 'Could not load the run' }, async () =>
    Response.json(await resumeIfIdle(await requireRun((await params).id)))
  );
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return respond('run:delete', { status: 500, message: 'Could not delete the run' }, async () => {
    await deleteRun((await requireRun((await params).id)).id);
    return Response.json({ ok: true });
  });
}
