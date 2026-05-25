import { PageShell } from '@/lib/components/page-shell';
import { ItemsByTypePane } from '@/lib/components/items-by-type-pane';

export default function ActivatorPage() {
  return (
    <PageShell
      title="Activator"
      subtitle="No-code event-driven automation. Watches a stream or KQL query and fires Teams/Email/Power Automate actions on conditions."
    >
      <ItemsByTypePane types={['activator']}
        emptyHint="No Activator rules in this tenant yet." />
    </PageShell>
  );
}
