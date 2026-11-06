import { MakeBook } from '@/components/shop/MakeBook';
import { listBooks } from '@/lib/store';
import { bookReady } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function Home() {
  return <MakeBook books={(await listBooks()).filter(bookReady)} />;
}
