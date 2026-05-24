import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function DeploymentPipelinesPage() {
  return (
    <PageShell
      title="Deployment pipelines"
      subtitle="Promote items across Development → Test → Production with diff review, deployment rules, and auto-binding."
    >
      <EmptyState
        icon="⇢"
        title="No pipelines yet"
        body="Create a deployment pipeline to promote workspace changes across three lifecycle stages. Loom auto-binds lakehouse and environment references across stages."
        primaryAction={{ label: 'New pipeline', href: '/deployment-pipelines/new' }}
      />
    </PageShell>
  );
}
