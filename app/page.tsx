import { MakeBook } from '@/components/shop/MakeBook';
import { listBooks, listExamples } from '@/lib/store';
import { bookReady, chosenFile, samplePeople, type ExampleCard } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [books, examples] = await Promise.all([listBooks(), listExamples()]);
  const cards: ExampleCard[] = examples.flatMap((e) => {
    const book = books.find((b) => b.id === e.bookId);
    if (!book) return [];
    const first = e.run.pageIndexes.map((i) => e.run.pages[i]).find((s) => s && chosenFile(s));
    return [{ id: e.id, title: book.title, people: e.cast.map((p) => p.name), pages: e.run.pageIndexes.length, cover: (first && chosenFile(first)) ?? '', ratio: `${book.pageWidth} / ${book.pageHeight}` }];
  });
  return <MakeBook books={books.filter(bookReady)} examples={cards} samples={samplePeople(examples)} />;
}
