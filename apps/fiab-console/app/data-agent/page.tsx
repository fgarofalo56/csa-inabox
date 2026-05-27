import { PageShell } from '@/lib/components/page-shell';
import { DataAgentPane } from '@/lib/panes/data-agent';

export default function DataAgentPage() {
  return (
    <PageShell
      title="Data agent"
      subtitle="Conversational Q&A grounded in your data. The cross-item Copilot orchestrator at /copilot is the production surface; this pane is preserved as a single-agent entry-point for tenants that pin a specific agent."
    >
      <DataAgentPane />
    </PageShell>
  );
}
