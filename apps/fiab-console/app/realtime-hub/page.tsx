import { PageShell } from '@/lib/components/page-shell';
import { RealTimeHubPane } from '@/lib/panes/real-time-hub';

export default function RealTimeHubPage() {
  return (
    <PageShell
      title="Real-Time hub"
      subtitle="Discover, subscribe to, and act on streaming event sources — Azure, external clouds, Fabric events, and OneLake events."
    >
      <RealTimeHubPane />
    </PageShell>
  );
}
