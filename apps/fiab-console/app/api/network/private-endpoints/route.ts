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
  buildHostsBlock, bindLoomServices,
  NetworkDiscoveryError, type FailedSub,
} from '@/lib/azure/network-discovery';
import { swrAwait } from '@/lib/azure/cross-sub-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Short-TTL cache window (ms) for the heavy cross-sub discovery. A reload / retry
 *  within this window is served instantly from the in-process SWR cache instead of
 *  re-running the multi-subscription fan-out. */
const DISCOVERY_TTL_MS = 45_000;

/** Run the full network discovery ONCE. Every per-sub fan-out is now parallel +
 *  per-sub-timeout-bounded (network-discovery `perSub`), and the four independent
 *  reads run concurrently, so total latency is ~one slow subscription — not the
 *  sum of all of them (the 6s cliff the client used to hit). Subscriptions that
 *  time out / are unreadable are recorded and surfaced as an honest partial note,
 *  never a whole-query failure. Throws only when subscription enumeration / token
 *  acquisition fails (→ the honest Reader-role gate). */
async function discoverNetwork() {
  const failed: FailedSub[] = [];
  // Kick all four cross-sub reads concurrently. DNS/VNet/NSG are best-effort
  // (a missing Reader on those scopes must never blank the PE inventory), so they
  // resolve to []; the PE read propagates a hard enumeration/token failure.
  const pePromise = listPrivateEndpoints(failed);
  const dnsPromise = listPrivateDnsZones().catch(() => []);
  const vnetPromise = listVirtualNetworks().catch(() => []);
  const nsgPromise = listNetworkSecurityGroups().catch(() => []);

  const endpoints = await pePromise;
  // Join each PE to the Loom logical service / owning domain it fronts, via Azure
  // Resource Graph (Reader-only) — overlaps the still-in-flight DNS/VNet/NSG reads.
  await bindLoomServices(endpoints);
  const [dnsZones, vnets, nsgs] = await Promise.all([dnsPromise, vnetPromise, nsgPromise]);

  const hostsBlock = buildHostsBlock(endpoints, dnsZones);
  const zones = Array.from(new Set([
    ...endpoints.flatMap((e) => e.dns.map((r) => r.zone)),
    ...dnsZones.map((z) => z.name),
  ])).filter(Boolean).sort();

  const partial = failed.length
    ? `Showing the subscriptions that responded. ${failed.length} subscription(s) `
      + 'timed out or were unreadable and were skipped — reload to retry them.'
    : undefined;

  return {
    count: endpoints.length,
    endpoints,
    zones,
    dnsZones,
    vnets,
    nsgs,
    hostsBlock: hostsBlock.split('\n').length > 1 ? hostsBlock : '',
    ...(partial ? { partial } : {}),
  };
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    // SWR: first call runs the real discovery; a reload/retry within the TTL is
    // instant. Keyed by the caller's oid so one user never reads another's rows.
    // A rejected discovery (auth/enumeration failure) is NOT cached — it flows to
    // the honest-gate catch below.
    const { value } = await swrAwait(
      session.claims.oid || '',
      'network:private-endpoints',
      { ttlMs: DISCOVERY_TTL_MS },
      discoverNetwork,
    );
    return NextResponse.json({ ok: true, ...value });
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
