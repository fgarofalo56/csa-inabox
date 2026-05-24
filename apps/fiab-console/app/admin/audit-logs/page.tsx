import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { Title3 } from '@fluentui/react-components';

export default function AuditLogsPage() {
  return (
    <AdminShell>
      <Title3 as="h2" style={{ marginBottom: 16 }}>Audit logs</Title3>
      <EmptyState
        icon="◐"
        title="Audit feed will appear here"
        body="Microsoft 365 audit log activity for every Fabric operation. Filter by user, item type, workspace, capacity, and date range. Export to CSV."
      />
    </AdminShell>
  );
}
