import { extname } from 'node:path';

import { respond } from '@/lib/http-error';
import { readDataFile } from '@/lib/store';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** Serves the images and fonts under data/. Local tool: no auth. */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return respond('files', { status: 404, message: 'Not found' }, async () => {
    const relative = (await params).path.join('/');
    const type = TYPES[extname(relative).toLowerCase()];
    if (!type) return Response.json({ error: 'Not found' }, { status: 404 });
    const data = await readDataFile(relative);
    return new Response(new Uint8Array(data), { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
  });
}
