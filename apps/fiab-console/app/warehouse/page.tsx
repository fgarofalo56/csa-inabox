import { PageShell } from '@/lib/components/page-shell';
import { WarehousePane } from '@/lib/panes/warehouse';

export default function WarehousePage() {
  return (
    <PageShell title="Warehouse" subtitle="T-SQL warehouse with separated compute and storage. Legacy stub — Phase 3 ships the full Monaco T-SQL editor.">
      <WarehousePane />
    </PageShell>
  );
}
