import { PageShell } from '@/lib/components/page-shell';
import { ReceivedSharesView } from '@/lib/components/external-shares/received-shares-view';

export const dynamic = 'force-dynamic';

export default function ReceivedSharesPage() {
  return (
    <PageShell
      title="Shared with me (external)"
      subtitle="Data shared to you from another organization's tenant. Accept a share to confirm access to its read-only subset."
    >
      <ReceivedSharesView />
    </PageShell>
  );
}
