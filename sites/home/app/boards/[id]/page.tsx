import { PortalShell } from '@/components/Portal';
import { BoardDetailPanel } from '@/components/UserPanel';

export default async function BoardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PortalShell><BoardDetailPanel boardId={id} /></PortalShell>;
}
