import { PageShell } from '@/lib/components/page-shell';
import { WorkspacesPane } from '@/lib/panes/workspaces';

export default function WorkspacesPage() {
  return (
    <PageShell
      title="Workspaces"
      subtitle="A workspace is where you collaborate on items — lakehouses, notebooks, warehouses, reports, and everything else."
    >
      <WorkspacesPane />
    </PageShell>
  );
}
