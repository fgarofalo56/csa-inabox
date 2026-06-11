import { PageShell } from '@/lib/components/page-shell';
import { RtiHubView } from '@/lib/components/realtime-hub/rti-hub-view';

export default function RtiHubPage() {
  return (
    <PageShell
      title="Real-Time Intelligence hub"
      subtitle="Discover and connect streaming sources — every Event Hub, IoT Hub, and ADX cluster across your Azure subscriptions (live via Azure Resource Graph), plus your Loom eventstreams. Subscribe a source to wire it into a real eventstream; preview, test, query, and open deployed Loom items inline."
    >
      <RtiHubView />
    </PageShell>
  );
}
