import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { Title3 } from '@fluentui/react-components';

export default function UsagePage() {
  return (
    <AdminShell>
      <Title3 as="h2" style={{ marginBottom: 16 }}>Usage metrics</Title3>
      <EmptyState
        icon="◑"
        title="Feature usage &amp; adoption (preview)"
        body="30-day rolling activity, inventory snapshot, per-item details. Drill into capacity, workspace, user, item type, and operation. Identify inactive items for cleanup."
      />
    </AdminShell>
  );
}
