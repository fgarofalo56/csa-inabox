import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function UsersPage() {
  return (
    <AdminShell sectionTitle="Users, roles & licenses">
      <EmptyState
        icon="◓"
        title="Entra ID seats & Loom roles"
        body="Manage Loom workspace roles (Admin / Member / Contributor / Viewer) and the downstream Azure roles Loom requires per service (Synapse SQL admin, Databricks workspace admin, ADF contributor, ADLS Storage Blob Data Contributor, etc.). License costs roll up from Microsoft 365 admin center for Microsoft-licensed users and from Databricks / Synapse billing for service-licensed seats."
      />
    </AdminShell>
  );
}
