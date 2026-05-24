import { PageShell } from '@/lib/components/page-shell';
import { DataAgentPane } from '@/lib/panes/data-agent';

export default function DataAgentPage() {
  return (
    <PageShell title="Data agent" subtitle="Conversational Q&A grounded in your data. Legacy stub — Phase 4 ships the Fabric-parity editor.">
      <DataAgentPane />
    </PageShell>
  );
}
