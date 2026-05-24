import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { Title3 } from '@fluentui/react-components';

export default function AdminWorkspacesPage() {
  return (
    <AdminShell>
      <Title3 as="h2" style={{ marginBottom: 16 }}>Workspaces (tenant-wide)</Title3>
      <EmptyState
        icon="◒"
        title="Tenant workspace inventory"
        body="Every workspace, regardless of who owns it. Includes orphaned workspaces, deleted-but-retained workspaces, and capacity assignments. Admin-only listing."
        primaryAction={{ label: 'My workspaces', href: '/workspaces' }}
      />
    </AdminShell>
  );
}
