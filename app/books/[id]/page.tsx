import { notFound } from 'next/navigation';

import { BookEditor } from '@/components/editor/BookEditor';
import { getBook } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function BookPageRoute({ params }: { params: Promise<{ id: string }> }) {
  const book = await getBook((await params).id);
  if (!book) notFound();
  return <BookEditor initial={book} />;
}
