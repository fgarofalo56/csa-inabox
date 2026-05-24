import { PageShell } from '@/lib/components/page-shell';
import { SetupWizardPane } from '@/lib/panes/setup-wizard';

export default function SetupPage() {
  return (
    <PageShell title="Setup wizard" subtitle="Loom-specific tenant bootstrap — provision capacities, register the orchestrator, and seed the first workspace.">
      <SetupWizardPane />
    </PageShell>
  );
}
