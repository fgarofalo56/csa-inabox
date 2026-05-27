import { AdminShell } from '@/lib/components/admin-shell';
import { AdminGate } from '@/lib/components/admin-gate';

export default function SecurityPage() {
  return (
    <AdminShell sectionTitle="Security & governance">
      <AdminGate
        surface="Security & governance"
        backendRoute="/api/admin/security"
        envVar="LOOM_PURVIEW_ACCOUNT"
        bicepModule="platform/fiab/bicep/modules/governance/purview.bicep"
        extra="Sensitivity label coverage, DLP scan results, workspace identity audit, plus the Purview hub deep-link for unified governance across Fabric / M365 / Azure."
        deepLink="https://web.purview.azure.com/"
        deepLinkLabel="Microsoft Purview portal"
      />
    </AdminShell>
  );
}
