import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function UsersPage() {
  return (
    <AdminShell sectionTitle="Users & licenses">
      <EmptyState
        icon="◓"
        title="License assignments"
        body="View and assign Power BI Pro, Power BI Premium Per-User, and Fabric capacity licenses. Sourced from Microsoft 365 admin center via Microsoft Graph."
      />
    </AdminShell>
  );
}
