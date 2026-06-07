import { PageShell } from '@/lib/components/page-shell';
import { RtiHubView } from '@/lib/components/realtime-hub/rti-hub-view';

export default function RtiHubPage() {
  return (
    <PageShell
      title="Real-Time Intelligence hub"
      subtitle="Unified catalog of every streaming source across your Azure subscriptions — Event Hubs, IoT Hub, ADX, and Loom eventstreams — discovered live via Azure Resource Graph. Subscribe to connect a source as a real eventstream."
    >
      <RtiHubView />
    </PageShell>
  );
}
