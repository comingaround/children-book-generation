import { notFound } from 'next/navigation';

import { RunView } from '@/components/run/RunView';
import { getBook, getPerson, getRun } from '@/lib/store';
import type { Person } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const run = await getRun((await params).id);
  if (!run) notFound();
  const book = await getBook(run.bookId);
  if (!book) notFound();
  const people = (await Promise.all(run.cast.map((c) => getPerson(c.personId)))).filter((p): p is Person => !!p);
  const price = Number(process.env.IMAGE_PRICE_USD) || 0.134;
  return <RunView initial={run} book={book} people={people} price={price} />;
}
