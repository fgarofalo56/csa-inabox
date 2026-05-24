import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { Title3 } from '@fluentui/react-components';

export default function DomainsPage() {
  return (
    <AdminShell>
      <Title3 as="h2" style={{ marginBottom: 16 }}>Domains</Title3>
      <EmptyState
        icon="▣"
        title="No domains defined"
        body="Domains group workspaces into business areas (Finance, Operations, Marketing, etc.). The OneLake catalog and Govern tab respect the active domain selector."
        primaryAction={{ label: 'Add domain' }}
      />
    </AdminShell>
  );
}
