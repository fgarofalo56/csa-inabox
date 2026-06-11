import { PageShell } from '@/lib/components/page-shell';
import { RealTimeHubView } from '@/lib/components/realtime-hub/realtime-hub-view';

export default function RealTimeHubPage() {
  return (
    <PageShell
      title="Real-Time hub"
      subtitle="Your DEPLOYED streams catalog — every Loom eventstream and KQL table, with preview, test, endpoints, and open-editor actions. Use Connect a source to add Microsoft, Azure, and external sources. To discover raw Azure sources across all subscriptions, see the RTI catalog."
    >
      <RealTimeHubView />
    </PageShell>
  );
}
