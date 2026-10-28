import { MakeBook } from '@/components/shop/MakeBook';
import { listBooks, listPeople, listRuns } from '@/lib/store';
import { bookReady } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [books, people, runs] = await Promise.all([listBooks(), listPeople(), listRuns()]);
  return <MakeBook books={books.filter(bookReady)} initialPeople={people} runs={runs} />;
}
