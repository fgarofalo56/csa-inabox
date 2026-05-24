import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function DomainsPage() {
  return (
    <AdminShell sectionTitle="Domains">
      <EmptyState
        icon="▣"
        title="No domains defined"
        body="Domains group workspaces into business areas (Finance, Operations, Marketing, etc.). The OneLake catalog and Govern tab respect the active domain selector."
        primaryAction={{ label: 'Add domain' }}
      />
    </AdminShell>
  );
}
