import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function AdminLandingPage() {
  return (
    <AdminShell>
      <EmptyState
        icon="◇"
        title="Pick an area"
        body="Choose a section on the left to manage tenant settings, capacity, domains, security, audit logs, usage metrics, users, or the workspace inventory."
      />
    </AdminShell>
  );
}
