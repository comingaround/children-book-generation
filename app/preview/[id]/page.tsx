import { Preview } from '@/components/shop/Preview';
import { HOSTED } from '@/lib/hosted';

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const price = Number(process.env.IMAGE_PRICE_USD) || 0.134;
  return <Preview id={(await params).id} price={price} serverPdf={!HOSTED} />;
}
