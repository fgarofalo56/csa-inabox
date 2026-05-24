import { PageShell } from '@/lib/components/page-shell';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { WorkspacesPane } from '@/lib/panes/workspaces';

export default function WorkspacesPage() {
  return (
    <PageShell
      title="Workspaces"
      subtitle="A workspace is where you collaborate on items — lakehouses, notebooks, warehouses, reports, and everything else."
      actions={<NewItemDialog />}
    >
      <WorkspacesPane />
    </PageShell>
  );
}
