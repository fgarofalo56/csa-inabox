import { PageShell } from '@/lib/components/page-shell';
import { ItemsByTypePane } from '@/lib/components/items-by-type-pane';

export default function SemanticModelPage() {
  return (
    <PageShell
      title="Semantic models"
      subtitle="Power BI tabular datasets with measures, hierarchies, and row-level security. Powers every report, dashboard, and scorecard."
    >
      <ItemsByTypePane
        types={['semantic-model', 'report', 'dashboard', 'paginated-report', 'scorecard']}
        emptyHint="No Power BI items in this tenant yet."
      />
    </PageShell>
  );
}
