import { PageShell } from '@/lib/components/page-shell';
import { MonitorPane } from '@/lib/components/monitor/monitor-pane';

export default function MonitorHubPage() {
  return (
    <PageShell
      title="Monitor"
      subtitle="Azure Monitor for everything running in CSA Loom — resource inventory and health, platform metrics, Log Analytics (KQL), the Azure Activity Log, deployed-item telemetry, and alert rules. Every panel reads live from Azure Monitor / Log Analytics / ARM."
    >
      <MonitorPane />
    </PageShell>
  );
}
