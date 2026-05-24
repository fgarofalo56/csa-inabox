import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { Title3 } from '@fluentui/react-components';

export default function CapacityPage() {
  return (
    <AdminShell>
      <Title3 as="h2" style={{ marginBottom: 16 }}>Capacity settings</Title3>
      <EmptyState
        icon="◆"
        title="No capacities yet"
        body="Provision an F-SKU (pay-as-you-go) or a trial capacity in Azure, then assign workspaces to it. The Fabric Capacity Metrics app surfaces utilization, throttling, top items, and top users."
      />
    </AdminShell>
  );
}
