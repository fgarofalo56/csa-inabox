import { AdminShell } from '@/lib/components/admin-shell';
import { NetworkPane } from '@/lib/components/network/network-pane';

export default function AdminNetworkPage() {
  return (
    <AdminShell
      sectionTitle="Network & Private DNS"
      learn={{
        title: 'Network & Private DNS',
        content: 'Everything needed to reach the private-by-default Azure services Loom orchestrates: the private endpoints in play, a copy/paste hosts-file override for quick local access, and enterprise DNS guidance for wiring your resolvers to the Private DNS zones. Use it to diagnose and fix name-resolution when a service is unreachable.',
        tips: [
          'The hosts-file override is a fast local workaround; forwarding to the Private DNS zones is the durable enterprise fix.',
          'Each private endpoint maps a service to a private IP inside the hub VNet — resolution must return that IP, not the public one.',
          'If a service times out, confirm its Private DNS zone and endpoint before assuming the service itself is down.',
        ],
      }}
    >
      <NetworkPane />
    </AdminShell>
  );
}
