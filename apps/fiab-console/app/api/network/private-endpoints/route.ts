/**
 * GET /api/network/private-endpoints
 *
 * Lists every private endpoint the Console identity can read (real ARM), with
 * each FQDN→private-IP→privatelink-zone mapping, plus a pre-built hosts-file
 * block and the de-duplicated set of privatelink zones the enterprise DNS must
 * resolve. Powers the Network / Private DNS page so developers can reach the
 * (public-access-disabled) Azure services directly over the VPN.
 *
 * Honest gate (no-vaporware): when the identity can't enumerate subscriptions
 * or read private endpoints, returns ok:false with the exact Reader role to
 * grant — the page renders a warning MessageBar, not a blank table.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listPrivateEndpoints, listPrivateDnsZones, listVirtualNetworks, listNetworkSecurityGroups,
  buildHostsBlock,
  NetworkDiscoveryError, type PrivateDnsZoneInfo, type VNetInfo, type NsgInfo,
} from '@/lib/azure/network-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const endpoints = await listPrivateEndpoints();
    // Private DNS zone A-records are the AUTHORITATIVE FQDN→IP source — enumerate
    // them so the hosts block covers EVERY private-only service, not just the
    // endpoints that echoed an IP. vNets/subnets power the topology view. Both
    // are best-effort: a missing Reader on these scopes never blanks the PEs.
    let dnsZones: PrivateDnsZoneInfo[] = [];
    let vnets: VNetInfo[] = [];
    let nsgs: NsgInfo[] = [];
    try { dnsZones = await listPrivateDnsZones(); } catch { /* keep PE-derived hosts */ }
    try { vnets = await listVirtualNetworks(); } catch { /* topology degrades gracefully */ }
    try { nsgs = await listNetworkSecurityGroups(); } catch { /* topology omits NSG nodes */ }

    const hostsBlock = buildHostsBlock(endpoints, dnsZones);
    // Union of zone names from PE records + the discovered private DNS zones.
    const zones = Array.from(new Set([
      ...endpoints.flatMap((e) => e.dns.map((r) => r.zone)),
      ...dnsZones.map((z) => z.name),
    ])).filter(Boolean).sort();

    return NextResponse.json({
      ok: true,
      count: endpoints.length,
      endpoints,
      zones,
      dnsZones,
      vnets,
      nsgs,
      hostsBlock: hostsBlock.split('\n').length > 1 ? hostsBlock : '',
    });
  } catch (e: any) {
    const status = e instanceof NetworkDiscoveryError ? e.status : 502;
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      hint:
        'The Console identity must be able to read private endpoints. Grant the Console UAMI ' +
        '(LOOM_UAMI_CLIENT_ID) the Reader role on the subscription (or the resource groups holding ' +
        'the private endpoints) — Microsoft.Network/privateEndpoints/read — then reload.',
    }, { status: status === 401 || status === 403 ? 200 : status });
  }
}
