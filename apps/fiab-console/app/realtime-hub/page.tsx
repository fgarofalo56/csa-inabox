import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function RealTimeHubPage() {
  return (
    <PageShell
      title="Real-Time hub"
      subtitle="Discover, subscribe to, and act on streaming event sources — Azure, external clouds, Fabric events, and OneLake events."
    >
      <EmptyState
        icon="⚡"
        title="No streams yet"
        body="Connect an Azure Event Hub, IoT Hub, CDC source, Kafka cluster, or one of the external sources (Google Pub/Sub, Kinesis, MQTT, Solace) to start ingesting events."
        primaryAction={{ label: 'Add a source', href: '/items/eventstream/new' }}
      />
    </PageShell>
  );
}
