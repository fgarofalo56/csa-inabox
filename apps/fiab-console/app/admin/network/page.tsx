import { AdminShell } from '@/lib/components/admin-shell';
import { NetworkPane } from '@/lib/components/network/network-pane';

export default function AdminNetworkPage() {
  return (
    <AdminShell sectionTitle="Network & Private DNS">
      <NetworkPane />
    </AdminShell>
  );
}
