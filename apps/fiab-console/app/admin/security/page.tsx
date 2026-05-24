import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';

export default function SecurityPage() {
  return (
    <AdminShell sectionTitle="Security & governance">
      <EmptyState
        icon="◊"
        title="Govern your data estate"
        body="Sensitivity label coverage, DLP scan results, workspace identity audit, and a deep link to the Microsoft Purview hub for unified data governance across Fabric, M365, and Azure."
      />
    </AdminShell>
  );
}
