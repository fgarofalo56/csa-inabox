import { PageShell } from '@/lib/components/page-shell';
import { ActivityFeedPane } from '@/lib/components/activity-feed-pane';

export default function GovernancePage() {
  return (
    <PageShell
      title="Governance"
      subtitle="Every audit, comment, and share across your tenant. Real activity from Cosmos — no fake numbers."
    >
      <ActivityFeedPane />
    </PageShell>
  );
}
