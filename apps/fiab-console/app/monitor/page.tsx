import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function MonitorHubPage() {
  return (
    <PageShell
      title="Monitor"
      subtitle="A centralized view of job health for every Fabric item — pipelines, notebooks, dataflows, Spark jobs, ML experiments, and more."
    >
      <EmptyState
        icon="◔"
        title="No recent activity"
        body="As pipelines, notebooks, and dataflows run, their status, duration, and error details will show up here. Filter by item type or status, or jump to historical runs for any item."
        primaryAction={{ label: 'Go to workspaces', href: '/workspaces' }}
      />
    </PageShell>
  );
}
