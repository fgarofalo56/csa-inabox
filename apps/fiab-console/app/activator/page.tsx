import { PageShell } from '@/lib/components/page-shell';
import { ActivatorPane } from '@/lib/panes/activator';

export default function ActivatorPage() {
  return (
    <PageShell
      title="Activator"
      subtitle="No-code event-driven automation. Each rule is a real Azure Monitor scheduled-query alert that watches a KQL source and fires Teams/Email/Power Automate actions on conditions. Rules load from and persist to the backend; enable/disable and delete round-trip to Azure Monitor (ARM). A Fabric Reflex backend is opt-in (LOOM_ACTIVATOR_BACKEND=fabric)."
    >
      <ActivatorPane />
    </PageShell>
  );
}
