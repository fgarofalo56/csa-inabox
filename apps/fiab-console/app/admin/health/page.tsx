import { AdminShell } from '@/lib/components/admin-shell';
import { HealthPane } from '@/lib/components/admin/health-pane';

export default function AdminHealthPage() {
  return (
    <AdminShell sectionTitle="Health & self-audit">
      <HealthPane />
    </AdminShell>
  );
}
