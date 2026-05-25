import { PageShell } from '@/lib/components/page-shell';
import { ActivatorPane } from '@/lib/panes/activator';

export default function ActivatorPage() {
  return (
    <PageShell title="Activator" subtitle="Detect conditions on streaming data and trigger actions. Legacy stub — Phase 3 ships the full rule designer.">
      <ActivatorPane />
    </PageShell>
  );
}
