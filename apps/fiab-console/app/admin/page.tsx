import { AdminShell } from '@/lib/components/admin-shell';
import { AdminOverview } from '@/lib/panes/admin-overview';

export default function AdminLandingPage() {
  return (
    <AdminShell>
      <AdminOverview />
    </AdminShell>
  );
}
