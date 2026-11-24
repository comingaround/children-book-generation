import { BookEditor } from '@/components/editor/BookEditor';
import { LocalBook } from '@/components/editor/LocalBook';
import { HOSTED } from '@/lib/hosted';
import { getBook } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** A published book (edited on the local version; online, view only), else one imported in this browser. */
export default async function BookPageRoute({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const book = await getBook(id);
  return book ? <BookEditor initial={book} readOnly={HOSTED} /> : <LocalBook id={id} />;
}
