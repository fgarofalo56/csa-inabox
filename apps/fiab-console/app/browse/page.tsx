import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function BrowsePage() {
  return (
    <PageShell title="Browse" subtitle="Items shared with you, recent items, and favorites across every workspace you can access.">
      <EmptyState
        icon="◰"
        title="Nothing pinned yet"
        body="As you open items across workspaces they'll show up here as Recents. Favorite an item from its toolbar to pin it."
        primaryAction={{ label: 'Go to workspaces', href: '/workspaces' }}
      />
    </PageShell>
  );
}
