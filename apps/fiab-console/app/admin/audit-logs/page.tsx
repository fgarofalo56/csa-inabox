import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function AuditLogsPage() {
  return (
    <AdminShell sectionTitle="Audit logs">
      <EmptyState
        icon="◐"
        title="Audit feed will appear here"
        body="Microsoft 365 audit log activity for every Fabric operation. Filter by user, item type, workspace, capacity, and date range. Export to CSV."
      />
    </AdminShell>
  );
}
