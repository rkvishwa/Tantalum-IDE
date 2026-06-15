import { PortalShell } from '@/components/Portal';
import { AdminPanel } from '@/components/AdminPanel';

export default function AdminPage() {
  return <PortalShell admin><AdminPanel /></PortalShell>;
}
