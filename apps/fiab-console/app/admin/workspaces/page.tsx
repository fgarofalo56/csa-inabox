import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function AdminWorkspacesPage() {
  return (
    <AdminShell sectionTitle="Workspaces (tenant-wide)">
      <EmptyState
        icon="◒"
        title="Tenant workspace inventory"
        body="Every workspace, regardless of who owns it. Includes orphaned workspaces, deleted-but-retained workspaces, and capacity assignments. Admin-only listing."
        primaryAction={{ label: 'My workspaces', href: '/workspaces' }}
      />
    </AdminShell>
  );
}
