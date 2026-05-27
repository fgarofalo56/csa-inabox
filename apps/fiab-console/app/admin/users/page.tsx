import { AdminShell } from '@/lib/components/admin-shell';
import { AdminGate } from '@/lib/components/admin-gate';

export default function UsersPage() {
  return (
    <AdminShell sectionTitle="Users, roles & licenses">
      <AdminGate
        surface="Users, roles & licenses"
        backendRoute="/api/admin/users"
        envVar="LOOM_GRAPH_READ_ALL_GRANTED"
        extra="Loom workspace roles (Admin / Member / Contributor / Viewer) + downstream Azure RBAC (Synapse SQL admin, Databricks workspace admin, ADF contributor, ADLS Blob Data Contributor). License roll-up from M365 admin center + Databricks/Synapse billing. Requires Microsoft Graph Directory.Read.All grant to the Console UAMI."
        deepLink="https://admin.microsoft.com/Adminportal/Home#/users"
        deepLinkLabel="Microsoft 365 admin · Users"
      />
    </AdminShell>
  );
}
