import { PageShell } from '@/lib/components/page-shell';
import { DataAgentPane } from '@/lib/panes/data-agent';

export default function DataAgentPage() {
  return (
    <PageShell
      title="Data agent"
      subtitle="Pick a published data agent and ask plain-language questions grounded in your warehouse, lakehouse, semantic models, and KQL. The cross-item orchestrator lives at /copilot."
    >
      <DataAgentPane />
    </PageShell>
  );
}
