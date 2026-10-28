import { extname } from 'node:path';

import { respond } from '@/lib/http-error';
import { getRun, readDataFile } from '@/lib/store';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * A customer's preview art loads in the page but won't open on its own (new tab, pasted URL)
 * until they order: browsers send Sec-Fetch-Dest "image" for an <img>, "document" for a tab.
 */
async function lockedPreview(req: Request, relative: string): Promise<boolean> {
  const runId = relative.match(/^runs\/([^/]+)\//)?.[1];
  if (!runId || req.headers.get('sec-fetch-dest') !== 'document') return false;
  const run = await getRun(runId);
  return !!run?.preview && !run.ordered;
}

/** Serves the images and fonts under data/. Local tool: no auth. */
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return respond('files', { status: 404, message: 'Not found' }, async () => {
    const relative = (await params).path.join('/');
    const type = TYPES[extname(relative).toLowerCase()];
    if (!type || (await lockedPreview(req, relative))) return Response.json({ error: 'Not found' }, { status: 404 });
    const data = await readDataFile(relative);
    return new Response(new Uint8Array(data), { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
  });
}
