import { PageShell } from '@/lib/components/page-shell';
import { ItemsByTypePane } from '@/lib/components/items-by-type-pane';

export default function RealTimeHubPage() {
  return (
    <PageShell
      title="Real-Time hub"
      subtitle="Streaming sources and the destinations they feed — Eventstream, Eventhouse, KQL databases, KQL dashboards, and Activator alerts."
    >
      <ItemsByTypePane
        types={[
          'eventstream', 'eventhouse', 'kql-database',
          'kql-queryset', 'kql-dashboard', 'activator',
        ]}
        emptyHint="No real-time items in this tenant yet."
      />
    </PageShell>
  );
}
