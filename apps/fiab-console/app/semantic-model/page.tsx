import { PageShell } from '@/lib/components/page-shell';
import { ItemsByTypePane } from '@/lib/components/items-by-type-pane';
import { SemanticModelWorkspacePane } from '@/lib/panes/semantic-model';

export default function SemanticModelPage() {
  return (
    <PageShell
      title="Semantic models"
      subtitle="Power BI tabular datasets with measures, hierarchies, and row-level security. Powers every report, dashboard, and scorecard."
    >
      {/* Workspace-level deploy surface: live AAS databases + real XMLA/Fabric
          writeback (Azure-native default, Fabric opt-in). */}
      <SemanticModelWorkspacePane />
      {/* Browse every Power BI item type in this tenant. */}
      <ItemsByTypePane
        types={['semantic-model', 'report', 'dashboard', 'paginated-report', 'scorecard']}
        emptyHint="No Power BI items in this tenant yet."
      />
    </PageShell>
  );
}
