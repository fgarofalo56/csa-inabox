import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { Title3 } from '@fluentui/react-components';

export default function TenantSettingsPage() {
  return (
    <AdminShell>
      <Title3 as="h2" style={{ marginBottom: 16 }}>Tenant settings</Title3>
      <EmptyState
        icon="⚙"
        title="Tenant switches will land here"
        body="Mirrors the Fabric admin portal tenant-settings tabs: Power BI, Fabric, R/Python visuals, Audit & usage, Help & support, Workspace settings, Information protection, Export & sharing, Discovery, Developer, Integration, Q&A, Dataflow, Data protection, Template apps, AI & Copilot, OneLake, Mirroring, Real-Time Intelligence, Workload settings, Git integration, Domain management."
      />
    </AdminShell>
  );
}
