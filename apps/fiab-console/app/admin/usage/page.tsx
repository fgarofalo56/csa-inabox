import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function UsagePage() {
  return (
    <AdminShell sectionTitle="Usage metrics">
      <EmptyState
        icon="◑"
        title="Feature usage & adoption (preview)"
        body="30-day rolling activity, inventory snapshot, per-item details. Drill into capacity, workspace, user, item type, and operation. Identify inactive items for cleanup."
      />
    </AdminShell>
  );
}
