import { PageShell } from '@/lib/components/page-shell';
import { WorkloadHubPane } from '@/lib/panes/workload-hub';

export default function WorkloadHubPage() {
  return (
    <PageShell
      title="Workload hub"
      subtitle="Discover, install, and manage Fabric workloads published by Microsoft and partners."
    >
      <WorkloadHubPane />
    </PageShell>
  );
}
