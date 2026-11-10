import { Studio } from '@/components/library/Studio';
import { HOSTED } from '@/lib/hosted';
import { listBooks } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** Published books are edited only on the local version; online, Edit books shows the visitor's own. */
export default async function StudioPage() {
  const price = Number(process.env.IMAGE_PRICE_USD) || 0.134;
  return <Studio books={HOSTED ? [] : await listBooks()} price={price} />;
}
