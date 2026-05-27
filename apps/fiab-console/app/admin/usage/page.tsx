import { AdminShell } from '@/lib/components/admin-shell';
import { AdminGate } from '@/lib/components/admin-gate';

export default function UsagePage() {
  return (
    <AdminShell sectionTitle="Usage metrics">
      <AdminGate
        surface="Usage metrics"
        backendRoute="/api/admin/usage"
        envVar="LOOM_AI_SEARCH_SERVICE"
        extra="30-day rolling activity, inventory snapshot, drill into capacity / workspace / user / item type / operation. Inactive-item finder for cleanup. Backed by the loom-items AI Search index + loom-audit-logs aggregator."
        deepLink="https://app.fabric.microsoft.com/admin-portal/usage"
        deepLinkLabel="Fabric Admin · Usage metrics"
      />
    </AdminShell>
  );
}
