import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { Title3 } from '@fluentui/react-components';

export default function SecurityPage() {
  return (
    <AdminShell>
      <Title3 as="h2" style={{ marginBottom: 16 }}>Security &amp; governance</Title3>
      <EmptyState
        icon="◊"
        title="Govern your data estate"
        body="Sensitivity label coverage, DLP scan results, workspace identity audit, and a deep link to the Microsoft Purview hub for unified data governance across Fabric, M365, and Azure."
      />
    </AdminShell>
  );
}
