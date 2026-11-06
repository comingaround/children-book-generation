import { RunView } from '@/components/run/RunView';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const price = Number(process.env.IMAGE_PRICE_USD) || 0.134;
  return <RunView id={(await params).id} price={price} />;
}
