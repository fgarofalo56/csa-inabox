import { AdminShell } from '@/lib/components/admin-shell';
import { EnvConfigPane } from '@/lib/components/admin/env-config-pane';

export default function AdminEnvConfigPage() {
  return (
    <AdminShell sectionTitle="Runtime configuration">
      <EnvConfigPane />
    </AdminShell>
  );
}
