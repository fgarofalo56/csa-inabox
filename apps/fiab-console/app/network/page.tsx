import { PageShell } from '@/lib/components/page-shell';
import { NetworkPane } from '@/lib/components/network/network-pane';

export default function NetworkPage() {
  return (
    <PageShell
      title="Network & Private DNS"
      subtitle="Every Azure service behind CSA Loom is deployed with public access disabled and reached over a private endpoint + private DNS. This page lists those endpoints with their private IPs, gives you a copy/paste hosts-file override for local development, and the exact enterprise DNS + VPN configuration so you can reach the services directly outside the app."
    >
      <NetworkPane />
    </PageShell>
  );
}
