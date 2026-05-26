import { PageShell } from '@/lib/components/page-shell';
import { ItemsByTypePane } from '@/lib/components/items-by-type-pane';

export default function DeploymentPipelinesPage() {
  return (
    <PageShell
      title="Deployment pipelines"
      subtitle="Promote items across Development → Test → Production. Lists every data-pipeline, ADF pipeline, Synapse pipeline, and copy job in your tenant."
    >
      <ItemsByTypePane
        types={['data-pipeline', 'synapse-pipeline', 'adf-pipeline', 'copy-job', 'dbt-job', 'airflow-job']}
        emptyHint="No pipeline items in this tenant yet."
      />
    </PageShell>
  );
}
