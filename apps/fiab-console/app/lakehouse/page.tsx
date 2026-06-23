import { PageShell } from '@/lib/components/page-shell';
import { LakehousePane } from '@/lib/panes/lakehouse';

export default function LakehousePage() {
  return (
    <PageShell title="Lakehouse" subtitle="Files, tables, and shortcuts over your Azure-native lakehouse (ADLS Gen2 + Delta).">
      <LakehousePane />
    </PageShell>
  );
}
