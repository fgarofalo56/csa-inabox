import { PageShell } from '@/lib/components/page-shell';
import { OneLakeCatalogPane } from '@/lib/panes/onelake-catalog';

export default function OneLakeCatalogPage() {
  return (
    <PageShell
      title="OneLake catalog"
      subtitle="Find, explore, and govern every data item your tenant exposes — across workspaces and domains."
    >
      <OneLakeCatalogPane />
    </PageShell>
  );
}
