import { Studio, type StudioExample } from '@/components/library/Studio';
import { HOSTED } from '@/lib/hosted';
import { listBooks, listExamples } from '@/lib/store';
import { chosenFile } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Published books are edited on the local version only; online they open view only, beside the
 * visitor's own imported books, with the finished examples made from them.
 */
export default async function StudioPage() {
  const price = Number(process.env.IMAGE_PRICE_USD) || 0.134;
  const [books, examples] = await Promise.all([listBooks(), HOSTED ? listExamples() : Promise.resolve([])]);
  const shown: StudioExample[] = examples.flatMap((e) => {
    const book = books.find((b) => b.id === e.bookId);
    if (!book) return [];
    const first = e.run.pageIndexes.map((i) => e.run.pages[i]).find((s) => s && chosenFile(s));
    return [{ id: e.id, title: book.title, people: e.cast.map((p) => p.name).join(', '), pages: e.run.pageIndexes.length, cover: (first && chosenFile(first)) ?? '' }];
  });
  return <Studio books={books} price={price} viewOnly={HOSTED} examples={shown} />;
}
