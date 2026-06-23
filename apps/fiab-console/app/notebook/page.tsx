import { PageShell } from '@/lib/components/page-shell';
import { NotebookPane } from '@/lib/panes/notebook';

export default function NotebookPage() {
  return (
    <PageShell title="Notebook" subtitle="Interactive Spark / Python authoring — cells, kernels, and live execution against your Azure-native compute.">
      <NotebookPane />
    </PageShell>
  );
}
