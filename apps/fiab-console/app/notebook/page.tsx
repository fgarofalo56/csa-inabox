import { PageShell } from '@/lib/components/page-shell';
import { NotebookPane } from '@/lib/panes/notebook';

export default function NotebookPage() {
  return (
    <PageShell title="Notebook" subtitle="Interactive Spark / Python authoring. Legacy stub — Phase 2 ships the full cell + kernel editor.">
      <NotebookPane />
    </PageShell>
  );
}
