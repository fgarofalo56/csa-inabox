import { AdminShell } from '@/lib/components/admin-shell';
import { AdminGate } from '@/lib/components/admin-gate';

export default function TenantSettingsPage() {
  return (
    <AdminShell sectionTitle="Tenant settings">
      <AdminGate
        surface="Tenant settings"
        backendRoute="/api/admin/tenant-settings"
        cosmosContainer="loom-tenant-settings"
        bicepModule="platform/fiab/bicep/modules/admin/tenant-settings.bicep"
        extra="15 Loom-specific category groups: OneLake, RTI, AI & Copilot, Mirroring, Synapse, Databricks, ADF, Git, Domains, Info protection, Export & sharing, Help & support, Billing, Purview, U-SQL legacy. Fabric tenant settings parity (160 toggles) is a separate follow-up."
        deepLink="https://app.fabric.microsoft.com/admin-portal/tenantSettings"
        deepLinkLabel="Fabric Admin · Tenant settings"
      />
    </AdminShell>
  );
}
