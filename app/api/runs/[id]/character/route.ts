import { HttpError, respond } from '@/lib/http-error';
import { approveCharacter, regenerateCharacter, selectCharacter } from '@/lib/runner';
import { requireRun } from '@/lib/store';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond('run:character', { status: 500, message: 'That did not work' }, async () => {
    const { id } = await params;
    const { action, attempt } = (await req.json()) as { action?: string; attempt?: number };
    if (action === 'approve') return Response.json(await approveCharacter(id));
    if (action === 'select' && typeof attempt === 'number') return Response.json(await selectCharacter(id, attempt));
    if (action === 'regenerate') {
      await regenerateCharacter(id);
      return Response.json(await requireRun(id));
    }
    throw new HttpError(400, 'Unknown action');
  });
}
