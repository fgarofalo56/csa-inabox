import { AdminShell } from '@/lib/components/admin-shell';
import { AdminGate } from '@/lib/components/admin-gate';

export default function DomainsPage() {
  return (
    <AdminShell sectionTitle="Domains">
      <AdminGate
        surface="Domains"
        backendRoute="/api/admin/domains"
        cosmosContainer="loom-domains"
        bicepModule="platform/fiab/bicep/modules/governance/domains.bicep"
        extra="Domains group workspaces into business areas (Finance, Operations, Marketing). The OneLake catalog + Govern tab respect the active domain selector once wired."
        deepLink="https://app.fabric.microsoft.com/admin-portal/domains"
        deepLinkLabel="Fabric Admin · Domains"
      />
    </AdminShell>
  );
}
