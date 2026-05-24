import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function CapacityPage() {
  return (
    <AdminShell sectionTitle="Capacity settings">
      <EmptyState
        icon="◆"
        title="No capacities yet"
        body="Provision an F-SKU (pay-as-you-go) or a trial capacity in Azure, then assign workspaces to it. The Fabric Capacity Metrics app surfaces utilization, throttling, top items, and top users."
      />
    </AdminShell>
  );
}
