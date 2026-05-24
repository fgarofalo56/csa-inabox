import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { Title3 } from '@fluentui/react-components';

export default function UsersPage() {
  return (
    <AdminShell>
      <Title3 as="h2" style={{ marginBottom: 16 }}>Users &amp; licenses</Title3>
      <EmptyState
        icon="◓"
        title="License assignments"
        body="View and assign Power BI Pro, Power BI Premium Per-User, and Fabric capacity licenses. Sourced from Microsoft 365 admin center via Microsoft Graph."
      />
    </AdminShell>
  );
}
