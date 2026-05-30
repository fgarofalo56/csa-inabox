import { PageShell } from '@/lib/components/page-shell';
import { DeploymentPipelinesPane } from '@/lib/components/deployment/deployment-pipelines-pane';

export default function DeploymentPipelinesPage() {
  return (
    <PageShell
      title="Deployment pipelines"
      subtitle="Promote Fabric content across Development → Test → Production using real Fabric deployment pipelines, and review the platform's own ARM / bicep rollouts. Every action calls the live Fabric REST (deploymentPipelines) or Azure ARM (Microsoft.Resources/deployments)."
    >
      <DeploymentPipelinesPane />
    </PageShell>
  );
}
