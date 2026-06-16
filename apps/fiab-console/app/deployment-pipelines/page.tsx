import { PageShell } from '@/lib/components/page-shell';
import { DeploymentPipelinesPane } from '@/lib/components/deployment/deployment-pipelines-pane';

export default function DeploymentPipelinesPage() {
  return (
    <PageShell
      title="Deployment pipelines"
      subtitle="Promote content across Development → Test → Production. The Loom-native pipelines and ARM infra-deployment tabs work standalone — no Microsoft Fabric required: each Loom stage binds to a Loom workspace and runs a content-level compare + selective re-provision with per-stage data-source / parameter rules. The Fabric pipelines and Git integration tabs require a Microsoft Fabric tenant and the Console identity to be authorized for the Fabric APIs; without it they show an honest authorization gate."
    >
      <DeploymentPipelinesPane />
    </PageShell>
  );
}
