import { PageShell } from '@/lib/components/page-shell';
import { ItemsByTypePane } from '@/lib/components/items-by-type-pane';

export default function OneLakeCatalogPage() {
  return (
    <PageShell
      title="OneLake catalog"
      subtitle="Every data item your tenant exposes — lakehouses, warehouses, mirrored databases, KQL stores. Click into one to browse and query."
    >
      <ItemsByTypePane
        types={[
          'lakehouse', 'warehouse', 'mirrored-database',
          'mirrored-databricks', 'kql-database', 'eventhouse',
        ]}
        emptyHint="No data items in this tenant yet."
      />
    </PageShell>
  );
}
