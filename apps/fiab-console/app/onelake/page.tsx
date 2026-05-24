import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function OneLakeCatalogPage() {
  return (
    <PageShell
      title="OneLake catalog"
      subtitle="Find, explore, and govern every data item your tenant exposes — across workspaces and domains."
    >
      <EmptyState
        icon="◈"
        title="Catalog is loading"
        body="The OneLake catalog tree, lineage graph, sensitivity labels, and endorsement filters will appear here once your tenant has at least one indexed item."
        primaryAction={{ label: 'Browse workspaces', href: '/workspaces' }}
        secondaryAction={{ label: 'Govern (admin)', href: '/admin/security' }}
      />
    </PageShell>
  );
}
