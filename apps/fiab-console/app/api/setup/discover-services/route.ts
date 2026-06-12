/**
 * GET /api/setup/discover-services
 *   Adopt-existing discovery step (D6). Scans every subscription the Console
 *   identity can see for EXISTING instances of each reusable SHARED service
 *   (Purview, Log Analytics, Key Vault, AOAI/AI Services, Application Gateway,
 *   AI Search, APIM, ADX) via a SINGLE Azure Resource Graph query:
 *
 *     POST {arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
 *       query: Resources
 *              | where type in~ (<shared-service ARM types>)
 *              | project name, type, resourceGroup, subscriptionId, location,
 *                        sku=tostring(sku.name), kind, id
 *
 *   ONE query (not N) respects ARG's 15-query / 5-second throttle. Resource
 *   Graph honours RBAC — only resources in scopes where the principal has at
 *   least Reader come back, so the candidate lists are honest (no mock data;
 *   per no-vaporware.md). Rows are bucketed into service keys by the shared
 *   catalog (lib/setup/shared-services.ts) — kept byte-identical with
 *   discover-services.sh so the wizard and the shell BYO path never drift.
 *
 *   The Setup Wizard renders one "reuse / deploy new / gate" card per service
 *   over these candidates; a reuse pick flows into bicep as the matching
 *   existing<Svc> parameter (generalising the loomPurviewAccount pattern).
 *
 *   Azure-native only — no Fabric type is ever scanned or offered
 *   (per no-fabric-dependency.md).
 *
 * Response shape:
 *   { ok: true,  services: { <key>: ServiceCandidate[] }, scannedTypes }
 *   { ok: false, error, hint? }
 */
import { NextResponse } from 'next/server';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';
import {
  SHARED_SERVICES,
  SHARED_SERVICE_ARM_TYPES,
  bucketRowToService,
  type SharedServiceKey,
  type ServiceCandidate,
} from '@/lib/setup/shared-services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI Reader on the subscriptions whose shared services you want to discover.',
      },
      { status: 502 },
    );
  }

  // Build the single ARG query over the union of shared-service ARM types.
  // `in~` is the case-insensitive set membership operator in KQL.
  const typeList = SHARED_SERVICE_ARM_TYPES.map((t) => `'${t}'`).join(', ');
  const query =
    `Resources | where type in~ (${typeList}) ` +
    `| project name, type, resourceGroup, subscriptionId, location, sku=tostring(sku.name), kind, id ` +
    `| order by type asc, name asc`;

  try {
    const res = await fetch(
      `${arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return NextResponse.json(
        {
          ok: false,
          error: `Resource Graph ${res.status}: ${t.slice(0, 200)}`,
          hint:
            res.status === 403
              ? 'The Console identity has Reader on no listed subscription. Grant it Reader where the shared services live.'
              : undefined,
        },
        { status: 502 },
      );
    }
    const j: any = await res.json();
    const rows = (j?.data || []) as any[];

    // Seed empty buckets so the UI shows every service card even when nothing
    // is discovered (the card then offers Deploy new / Gate honestly).
    const services: Record<SharedServiceKey, ServiceCandidate[]> = SHARED_SERVICES.reduce(
      (acc, s) => {
        acc[s.key] = [];
        return acc;
      },
      {} as Record<SharedServiceKey, ServiceCandidate[]>,
    );

    for (const row of rows) {
      const typeLower = String(row.type || '').toLowerCase();
      const kind = String(row.kind || '');
      const key = bucketRowToService(typeLower, kind);
      if (!key) continue;
      services[key].push({
        name: String(row.name || ''),
        rg: String(row.resourceGroup || ''),
        subscriptionId: String(row.subscriptionId || ''),
        region: String(row.location || ''),
        sku: String(row.sku || ''),
        kind,
        id: String(row.id || ''),
      });
    }

    return NextResponse.json({ ok: true, services, scannedTypes: SHARED_SERVICE_ARM_TYPES });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Resource Graph request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }
}
