import { respond } from '@/lib/http-error';
import { listPeople, listRuns } from '@/lib/store';

/**
 * People and runs that earlier versions saved in data/, for the browser to copy into its own
 * storage once (lib/local/legacy.ts). Their files stay readable under /api/files. Empty online.
 */
export async function GET() {
  return respond('legacy', { status: 500, message: 'Could not read the older saves' }, async () => {
    const [people, runs] = await Promise.all([listPeople(), listRuns()]);
    return Response.json({ people, runs });
  });
}
