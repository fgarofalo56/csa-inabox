import { AdminShell } from '@/lib/components/admin-shell';
import { AdminGate } from '@/lib/components/admin-gate';

export default function AuditLogsPage() {
  return (
    <AdminShell sectionTitle="Audit logs">
      <AdminGate
        surface="Audit logs"
        backendRoute="/api/admin/audit-logs"
        envVar="LOOM_M365_AUDIT_ENABLED"
        cosmosContainer="loom-audit-logs"
        bicepModule="platform/fiab/bicep/modules/governance/audit.bicep"
        deepLink="https://compliance.microsoft.com/auditlogsearch"
        deepLinkLabel="Microsoft Purview Audit"
        extra="Microsoft 365 audit log activity per Fabric operation, filterable by user / item type / workspace / capacity / date range, with CSV export."
      />
    </AdminShell>
  );
}
