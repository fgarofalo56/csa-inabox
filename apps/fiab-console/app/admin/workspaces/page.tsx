import { AdminShell } from '@/lib/components/admin-shell';
import { AdminGate } from '@/lib/components/admin-gate';

export default function AdminWorkspacesPage() {
  return (
    <AdminShell sectionTitle="Workspaces (tenant-wide)">
      <AdminGate
        surface="Workspaces (tenant-wide)"
        backendRoute="/api/admin/workspaces"
        cosmosContainer="loom-workspaces"
        extra="Tenant-wide workspace inventory regardless of ownership: orphaned workspaces, deleted-but-retained workspaces, capacity assignments. Backed by the existing /api/fabric/workspaces enumeration + admin-only DLZ resource inventory."
        deepLink="https://app.fabric.microsoft.com/admin-portal/workspaces"
        deepLinkLabel="Fabric Admin · Workspaces"
      />
    </AdminShell>
  );
}
