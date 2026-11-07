import { notFound } from 'next/navigation';

import { Studio } from '@/components/library/Studio';
import { HOSTED } from '@/lib/hosted';
import { listBooks } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function StudioPage() {
  if (HOSTED) notFound();
  const price = Number(process.env.IMAGE_PRICE_USD) || 0.134;
  return <Studio books={await listBooks()} price={price} />;
}
