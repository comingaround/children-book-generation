import { notFound } from 'next/navigation';

import { ExampleView } from '@/components/shop/ExampleView';
import { HOSTED } from '@/lib/hosted';
import { getBook, getExample } from '@/lib/store';
import { fileUrl } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ExamplePage({ params }: { params: Promise<{ id: string }> }) {
  const example = await getExample((await params).id);
  const book = example && (await getBook(example.bookId));
  if (!example || !book) notFound();
  // Online the PDF is a static file (scripts/stage-deploy.mjs): functions answer at most 4.5 MB.
  return <ExampleView example={example} book={book} pdfUrl={HOSTED ? `/${example.pdf}` : fileUrl(example.pdf)} />;
}
