/**
 * GET /api/setup/regions?subscription=<guid>&boundary=<Commercial|GCC|GCC-High|IL5|DoD>
 *   Returns the regions a Data Landing Zone can deploy into for the active
 *   cloud boundary. When a subscription id is supplied this lists the LIVE
 *   ARM `GET {arm}/subscriptions/{id}/locations?api-version=2022-12-01` set —
 *   i.e. exactly the regions that subscription is enabled for (ARM trims to the
 *   physical regions, so logical/edge zones are filtered out). When no
 *   subscription is supplied, or the ARM call fails, it falls back to the
 *   authoritative static per-boundary list from `azure-regions.ts`.
 *
 * The dropdown is always a CLOSED set (per loom-no-freeform-config.md) — either
 * the live ARM regions or the static fallback, never a free-text box.
 *
 * Response shape:
 *   { ok: true, source: 'arm' | 'static', regions: [{ name, display, geo }] }
 *   { ok: false, error }                                          (auth only)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import {
  regionsForBoundary,
  regionDisplayName,
  type AzureRegion,
  type RegionBoundary,
} from '@/lib/azure/azure-regions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_BOUNDARIES: RegionBoundary[] = ['Commercial', 'GCC', 'GCC-High', 'IL5', 'DoD'];

const credential = uamiArmCredential();

/** Live ARM region list for the chosen subscription. Returns null on any failure. */
async function liveRegions(subId: string): Promise<AzureRegion[] | null> {
  try {
    const arm = armBase();
    const t = await credential.getToken(`${arm}/.default`);
    if (!t?.token) return null;
    const r = await fetch(
      `${arm}/subscriptions/${subId}/locations?api-version=2022-12-01`,
      { headers: { authorization: `Bearer ${t.token}` }, cache: 'no-store' },
    );
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => null);
    const rows = (j?.value || []) as any[];
    // Only physical regions are valid `az deployment sub create -l` targets.
    const physical = rows.filter((l) => (l.metadata?.regionType || 'Physical') === 'Physical');
    if (physical.length === 0) return null;
    const regions: AzureRegion[] = physical.map((l) => ({
      name: l.name,
      display: l.displayName || regionDisplayName(l.name),
      geo: l.metadata?.geographyGroup || l.metadata?.geography || 'Other',
    }));
    regions.sort((a, b) => a.geo.localeCompare(b.geo) || a.display.localeCompare(b.display));
    return regions;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const subId = (searchParams.get('subscription') || '').trim();
  const boundaryParam = (searchParams.get('boundary') || 'Commercial').trim() as RegionBoundary;
  const boundary: RegionBoundary = VALID_BOUNDARIES.includes(boundaryParam) ? boundaryParam : 'Commercial';

  // Live ARM list only applies to the Azure-endpoint cloud the console runs in;
  // a Gov-boundary wizard still resolves Gov locations because armBase() is
  // cloud-correct. If no sub or the call is denied, fall back to the static set.
  if (GUID_RE.test(subId)) {
    const live = await liveRegions(subId);
    if (live) return NextResponse.json({ ok: true, source: 'arm', regions: live });
  }

  return NextResponse.json({ ok: true, source: 'static', regions: regionsForBoundary(boundary) });
}
