import { PageShell } from '@/lib/components/page-shell';
import { ActivityFeedPane } from '@/lib/components/activity-feed-pane';

export default function MonitorHubPage() {
  return (
    <PageShell
      title="Monitor"
      subtitle="Live job, edit, and share activity for every item in your tenant. Every entry below was written to Cosmos by an actual user action."
    >
      <ActivityFeedPane />
    </PageShell>
  );
}
