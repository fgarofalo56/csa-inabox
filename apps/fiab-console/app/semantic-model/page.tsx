import { PageShell } from '@/lib/components/page-shell';
import { SemanticModelPane } from '@/lib/panes/semantic-model';

export default function SemanticModelPage() {
  return (
    <PageShell title="Semantic model" subtitle="Tables, relationships, measures, roles. Legacy stub — Phase 3 ships the full model designer.">
      <SemanticModelPane />
    </PageShell>
  );
}
