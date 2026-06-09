import { PageShell } from '@/lib/components/page-shell';
import { DeploymentPipelinesPane } from '@/lib/components/deployment/deployment-pipelines-pane';

export default function DeploymentPipelinesPage() {
  return (
    <PageShell
      title="Deployment pipelines"
      subtitle="Promote content across Development → Test → Production. Loom-native pipelines bind each stage to a Loom workspace and run a content-level compare + selective re-provision with per-stage data-source / parameter rules — no Microsoft Fabric required. The Fabric, Git, and ARM tabs cover the Fabric REST deployment pipelines, Git integration, and the platform's own bicep rollouts."
    >
      <DeploymentPipelinesPane />
    </PageShell>
  );
}
