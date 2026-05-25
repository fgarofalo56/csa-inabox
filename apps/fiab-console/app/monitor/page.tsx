import { PageShell } from '@/lib/components/page-shell';
import { MonitorHubPane } from '@/lib/panes/monitor-hub';

export default function MonitorHubPage() {
  return (
    <PageShell
      title="Monitor"
      subtitle="A centralized view of job health for every Fabric item — pipelines, notebooks, dataflows, Spark jobs, ML experiments, and more."
    >
      <MonitorHubPane />
    </PageShell>
  );
}
