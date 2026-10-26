import { Library } from '@/components/library/Library';
import { listBooks, listChildren, listRuns } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [books, children, runs] = await Promise.all([listBooks(), listChildren(), listRuns()]);
  const price = Number(process.env.IMAGE_PRICE_USD) || 0.134;
  return <Library books={books} initialChildren={children} runs={runs} price={price} />;
}
