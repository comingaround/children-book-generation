import { Library } from '@/components/library/Library';
import { listBooks, listPeople, listRuns } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [books, people, runs] = await Promise.all([listBooks(), listPeople(), listRuns()]);
  const price = Number(process.env.IMAGE_PRICE_USD) || 0.134;
  return <Library books={books} initialPeople={people} runs={runs} price={price} />;
}
