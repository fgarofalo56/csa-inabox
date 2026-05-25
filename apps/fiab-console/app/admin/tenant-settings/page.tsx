import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function TenantSettingsPage() {
  return (
    <AdminShell sectionTitle="Tenant settings">
      <EmptyState
        icon="⚙"
        title="Loom tenant switches"
        body="Per-area toggles that control what Loom surfaces across the tenant: OneLake, Real-Time Intelligence, AI & Copilot, Mirroring, Synapse passthrough, Databricks passthrough, ADF passthrough, U-SQL legacy enablement, Git integration, Domain management, Information protection, Export & sharing, Help & support, Billing connections (Azure Cost Management hookup for the Capacity page), Purview account binding (for the Governance portal embed)."
      />
    </AdminShell>
  );
}
