import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function CopilotPage() {
  return (
    <PageShell
      title="Copilot"
      subtitle="Ask questions, generate code, and orchestrate actions across your Fabric workspace."
    >
      <EmptyState
        icon="✦"
        title="Copilot is initializing"
        body="The full-screen Copilot experience will land here. In the meantime, every editor surfaces a Copilot side-pane (Phase 6)."
      />
    </PageShell>
  );
}
