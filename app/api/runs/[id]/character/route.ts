import { HttpError, respond } from '@/lib/http-error';
import { approveCast, regenerateCharacter, selectCharacter } from '@/lib/runner';

/** Step 1 actions: `approve` (every drawing at once), or `regenerate` / `select` for one `characterId`. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond('run:character', { status: 500, message: 'That did not work' }, async () => {
    const { id } = await params;
    const { action, characterId, attempt } = (await req.json()) as { action?: string; characterId?: string; attempt?: number };
    if (action === 'approve') return Response.json(await approveCast(id));
    if (!characterId) throw new HttpError(400, 'Which character?');
    if (action === 'select' && typeof attempt === 'number') return Response.json(await selectCharacter(id, characterId, attempt));
    if (action === 'regenerate') return Response.json(await regenerateCharacter(id, characterId));
    throw new HttpError(400, 'Unknown action');
  });
}
