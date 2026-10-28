import { Studio } from '@/components/library/Studio';
import { listBooks, listRuns } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function StudioPage() {
  const [books, runs] = await Promise.all([listBooks(), listRuns()]);
  return <Studio books={books} runs={runs} />;
}
