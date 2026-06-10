import { PageShell } from '@/lib/components/page-shell';
import { BusinessEventsView } from '@/lib/components/business-events/business-events-view';

export default function BusinessEventsPage() {
  return (
    <PageShell
      title="Business events"
      subtitle="Publish structured, governed business signals to Event Hubs and Event Grid — discoverable in the Real-Time hub, capacity-metered, and consumable by Activator rules."
    >
      <BusinessEventsView />
    </PageShell>
  );
}
