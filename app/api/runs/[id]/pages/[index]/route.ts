import { HttpError, respond } from '@/lib/http-error';
import { regeneratePage, selectPageAttempt } from '@/lib/runner';

export async function POST(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  return respond('run:page', { status: 500, message: 'That did not work' }, async () => {
    const { id, index } = await params;
    const { action, attempt, fix } = (await req.json()) as { action?: string; attempt?: number; fix?: string };
    if (action === 'regenerate') return Response.json(await regeneratePage(id, Number(index), typeof fix === 'string' ? fix : undefined));
    if (action === 'select' && typeof attempt === 'number') return Response.json(await selectPageAttempt(id, Number(index), attempt));
    throw new HttpError(400, 'Unknown action');
  });
}
