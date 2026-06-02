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
import { listPrivateEndpoints, NetworkDiscoveryError } from '@/lib/azure/network-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const endpoints = await listPrivateEndpoints();
    const records = endpoints.flatMap((e) => e.dns);
    // hosts-file block: one "<ip>\t<fqdn>" line per A record (first IP wins).
    const seen = new Set<string>();
    const hostLines: string[] = [];
    for (const r of records) {
      if (!r.ips[0] || seen.has(r.fqdn)) continue;
      seen.add(r.fqdn);
      hostLines.push(`${r.ips[0]}\t${r.fqdn}`);
    }
    hostLines.sort((a, b) => a.split('\t')[1].localeCompare(b.split('\t')[1]));
    const zones = Array.from(new Set(records.map((r) => r.zone))).sort();

    return NextResponse.json({
      ok: true,
      count: endpoints.length,
      endpoints,
      zones,
      hostsBlock: hostLines.length
        ? ['# CSA Loom — Azure private endpoints (dev hosts override)', ...hostLines].join('\n')
        : '',
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
