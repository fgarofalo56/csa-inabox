import { PageShell } from '@/lib/components/page-shell';
import { RealTimeHubView } from '@/lib/components/realtime-hub/realtime-hub-view';

export default function RealTimeHubPage() {
  return (
    <PageShell
      title="Real-Time hub"
      subtitle="The single place to discover and connect all streaming data across your tenant — every eventstream and KQL table, plus Get events to connect Microsoft, Fabric, Azure, and external sources."
    >
      <RealTimeHubView />
    </PageShell>
  );
}
