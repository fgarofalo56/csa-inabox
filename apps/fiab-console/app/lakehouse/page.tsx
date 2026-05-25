import { PageShell } from '@/lib/components/page-shell';
import { LakehousePane } from '@/lib/panes/lakehouse';

export default function LakehousePage() {
  return (
    <PageShell title="Lakehouse" subtitle="Files, tables, and shortcuts in OneLake. Legacy stub — Phase 2 ships the full editor.">
      <LakehousePane />
    </PageShell>
  );
}
