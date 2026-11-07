import { notFound } from 'next/navigation';

import { BookEditor } from '@/components/editor/BookEditor';
import { HOSTED } from '@/lib/hosted';
import { getBook } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function BookPageRoute({ params }: { params: Promise<{ id: string }> }) {
  if (HOSTED) notFound();
  const book = await getBook((await params).id);
  if (!book) notFound();
  return <BookEditor initial={book} />;
}
