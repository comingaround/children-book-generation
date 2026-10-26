import { notFound } from 'next/navigation';

import { RunView } from '@/components/run/RunView';
import { getBook, getChild, getRun } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const run = await getRun((await params).id);
  if (!run) notFound();
  const [book, child] = await Promise.all([getBook(run.bookId), getChild(run.childId)]);
  if (!book) notFound();
  const price = Number(process.env.IMAGE_PRICE_USD) || 0.134;
  return <RunView initial={run} book={book} child={child} price={price} />;
}
