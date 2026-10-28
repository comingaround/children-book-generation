import { Studio } from '@/components/library/Studio';
import { listBooks } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function StudioPage() {
  return <Studio books={await listBooks()} />;
}
