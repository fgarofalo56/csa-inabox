import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function WorkloadHubPage() {
  return (
    <PageShell
      title="Workload hub"
      subtitle="Discover, install, and manage Fabric workloads published by Microsoft and partners."
    >
      <EmptyState
        icon="◇"
        title="No additional workloads installed"
        body="Loom ships with the core Fabric workloads (Data Engineering, Data Factory, Real-Time Intelligence, Power BI, Data Science, APIs, Fabric IQ). Partner workloads will appear here once your tenant admin enables them."
      />
    </PageShell>
  );
}
