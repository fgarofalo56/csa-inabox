import { PageShell } from '@/lib/components/page-shell';
import { DeploymentPipelinesPane } from '@/lib/panes/deployment-pipelines';

export default function DeploymentPipelinesPage() {
  return (
    <PageShell
      title="Deployment pipelines"
      subtitle="Promote items across Development → Test → Production with diff review, deployment rules, and auto-binding."
    >
      <DeploymentPipelinesPane />
    </PageShell>
  );
}
