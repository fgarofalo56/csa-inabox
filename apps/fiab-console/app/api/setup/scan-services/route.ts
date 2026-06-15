/**
 * GET /api/setup/scan-services
 *   The Setup Wizard's "scan-and-choose" primitive: discovers existing Azure
 *   backends Loom can wire — across EVERY subscription the Console identity can
 *   see — via a single Azure Resource Graph query, then runs the deterministic
 *   recommendation engine (lib/setup/scan-services) over the results.
 *
 *   Mirrors existing-dlzs/route.ts verbatim for auth + transport:
 *     POST {arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
 *   Resource Graph honours RBAC — only resources in scopes where the principal
 *   has at least Reader come back, so the scan is genuinely the operator's view.
 *   No mock data (no-vaporware.md): when nothing is visible the candidate lists
 *   are honestly empty and the recommendation falls to "provision new".
 *
 *   The KQL is built from the shared SETUP_SCAN_SERVICES catalog (the TS twin of
 *   byo-wizard.sh's SERVICES array) so the CLI + Wizard scan the same set
 *   (ui-parity.md). Every backend is Azure-native (no-fabric-dependency.md) —
 *   Fabric / Power BI is never scanned.
 *
 * Query string:
 *   ?deploySub=<guid>   — the deploy/admin subscription; a candidate there is
 *                         preferred by the recommendation engine. Optional.
 *
 * Response shape:
 *   { ok: true,  services: ScanServiceResult[] }
 *   { ok: false, error, hint? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';
import {
  SETUP_SCAN_SERVICES,
  recommendForService,
  canDisable,
  type ScanCandidate,
  type ScanServiceResult,
} from '@/lib/setup/scan-services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Distinct lowercase ARM types we scan (one Resource Graph `in~` set). */
const SCANNED_TYPES = Array.from(new Set(SETUP_SCAN_SERVICES.map((s) => s.armType)));

/**
 * Build a single union query over every scanned type. We `project` type, name,
 * resourceGroup, subscriptionId, location, and kind so the AIServices vs other
 * Cognitive Services split (AI Foundry) can be applied per-row in TS.
 */
function buildGraphQuery(): string {
  const typeList = SCANNED_TYPES.map((t) => `'${t}'`).join(',');
  return (
    'Resources ' +
    `| where type in~ (${typeList}) ` +
    '| project svcType=tolower(type), name, resourceGroup, subscriptionId, location, kind ' +
    '| order by name asc'
  );
}

/** Does this Resource Graph row satisfy the service definition's kind filter? */
function matchesKind(svcKind: string | undefined, kindFilter?: string): boolean {
  if (!kindFilter) return true;
  // Only AI Foundry uses a kind filter today (AIServices-kind accounts).
  return (svcKind || '').toLowerCase() === 'aiservices';
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const deploySub = (req.nextUrl.searchParams.get('deploySub') || process.env.LOOM_SUBSCRIPTION_ID || '').trim() || undefined;

  const arm = armBase();
  let token: string;
  try {
    const t = await credential.getToken(`${arm}/.default`);
    if (!t?.token) throw new Error('empty token');
    token = t.token;
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI Reader on the subscriptions you want the scan to cover.',
      },
      { status: 502 },
    );
  }

  let rows: any[];
  try {
    const res = await fetch(
      `${arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: buildGraphQuery(), options: { top: 1000 } }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return NextResponse.json(
        { ok: false, error: `Resource Graph ${res.status}: ${t.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const j: any = await res.json();
    rows = (j?.data || []) as any[];
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Resource Graph request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }

  // Bucket discovered resources by service key.
  const services: ScanServiceResult[] = SETUP_SCAN_SERVICES.map((def) => {
    const candidates: ScanCandidate[] = rows
      .filter((r) => (r.svcType || '').toLowerCase() === def.armType && matchesKind(r.kind, def.kindFilter))
      .map((r) => ({
        name: r.name,
        rg: r.resourceGroup,
        sub: r.subscriptionId,
        region: r.location || undefined,
      }))
      .filter((c) => !!c.name);
    const { recommendation, recommendedCandidate } = recommendForService(def, candidates, deploySub);
    return {
      key: def.key,
      label: def.label,
      candidates,
      recommendation,
      recommendedCandidate,
      defaultOn: def.defaultOn,
      canDisable: canDisable(def),
    };
  });

  return NextResponse.json({ ok: true, services });
}
