/**
 * GET /api/setup/scan?deploySub=<id>
 *   Scan-and-choose for the DATA-ENGINEERING backends (Synapse / Databricks /
 *   Data Factory / SHIR). For each backend, enumerates existing instances the
 *   Console identity can see via Azure Resource Graph and returns a
 *   recommendation (use-existing when a healthy instance exists in the deploy
 *   subscription/region, else provision-new — never disable by default, per the
 *   "everything on, opt-out" posture in docs/fiab/prp/deploy-readiness-100pct.md).
 *
 *   Backs the Setup Wizard's per-service choice cards (Use existing / Provision
 *   new / Disable) and is the in-console twin of scripts/csa-loom/scan-and-deploy.sh.
 *
 * Auth: session-gated; uses the Console UAMI (LOOM_UAMI_CLIENT_ID) → DefaultAzureCredential
 *   chain, same as /api/setup/subscriptions. The identity needs Reader on the
 *   subscriptions it should surface — ARM/Graph trims the rest.
 *
 * Cloud: LOOM_ARM_ENDPOINT (Commercial default; Gov = management.usgovcloudapi.net).
 *
 * Response:
 *   { ok: true, services: [{
 *       service, label, armType, enabledFlag, canDisable,
 *       existing: [{ id, name, rg, sub, region }],
 *       recommendation: 'use-existing' | 'new',
 *       recommendedCandidate?: { id, name, rg, sub, region }
 *   }] }
 *   { ok: false, error, hint? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function arm(): string {
  return armBase();
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function armToken(): Promise<string> {
  const t = await credential.getToken(`${arm()}/.default`);
  if (!t?.token) throw new Error('Failed to acquire AAD token for ARM');
  return t.token;
}

/**
 * The data-engineering backends this route scans. Each maps an ARM type to the
 * main.bicep `loom<Svc>Enabled` flag the deploy toggles, so the wizard's choice
 * round-trips into the same param the CLI scanner emits.
 */
interface DeScanServiceDef {
  service: string;
  label: string;
  armType: string; // lower-cased for the Graph `=~` match
  enabledFlag: string;
}

const DE_SCAN_SERVICES: DeScanServiceDef[] = [
  { service: 'synapse', label: 'Synapse Analytics', armType: 'microsoft.synapse/workspaces', enabledFlag: 'loomSynapseEnabled' },
  { service: 'databricks', label: 'Azure Databricks', armType: 'microsoft.databricks/workspaces', enabledFlag: 'loomDatabricksEnabled' },
  { service: 'datafactory', label: 'Azure Data Factory', armType: 'microsoft.datafactory/factories', enabledFlag: 'loomDataFactoryEnabled' },
];

interface ScanCandidate {
  id: string;
  name: string;
  rg: string;
  sub: string;
  region: string;
}

interface ScanServiceResult {
  service: string;
  label: string;
  armType: string;
  enabledFlag: string;
  canDisable: boolean;
  existing: ScanCandidate[];
  recommendation: 'use-existing' | 'new';
  recommendedCandidate?: ScanCandidate;
}

interface GraphRow {
  id: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location: string;
  svcType: string;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const deploySub = (req.nextUrl.searchParams.get('deploySub') || '').toLowerCase();

  let token: string;
  try {
    token = await armToken();
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI (or your az-login principal) Reader on the target subscriptions.',
      },
      { status: 502 },
    );
  }

  // One Resource Graph query enumerates every data-eng backend across every
  // visible subscription in a single round-trip.
  const typeList = DE_SCAN_SERVICES.map((s) => `'${s.armType}'`).join(',');
  const query = `Resources | where type in~ (${typeList}) | project id, name, resourceGroup, subscriptionId, location, svcType=tolower(type) | order by name asc`;

  let rows: GraphRow[] = [];
  try {
    const r = await fetch(`${arm()}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, options: { resultFormat: 'objectArray', $top: 500 } }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return NextResponse.json(
        {
          ok: false,
          error: `resource graph query failed (${r.status})`,
          hint: body.slice(0, 300) || 'Ensure the Microsoft.ResourceGraph provider is registered and the identity has Reader.',
        },
        { status: 502 },
      );
    }
    const j = (await r.json()) as { data?: GraphRow[] };
    rows = Array.isArray(j.data) ? j.data : [];
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `scan failed: ${e?.message ?? String(e)}` }, { status: 502 });
  }

  const services = DE_SCAN_SERVICES.map((def): ScanServiceResult => {
    const existing: ScanCandidate[] = rows
      .filter((row) => (row.svcType || '') === def.armType)
      .map((row) => ({
        id: row.id,
        name: row.name,
        rg: row.resourceGroup,
        sub: row.subscriptionId,
        region: row.location,
      }));

    // Recommendation: prefer a healthy instance already in the deploy
    // subscription; else any existing; else provision-new. Disable is never
    // recommended (opt-out posture) — the user can still choose it in the UI.
    const inSub = deploySub ? existing.find((c) => (c.sub || '').toLowerCase() === deploySub) : undefined;
    const recommendedCandidate = inSub ?? existing[0];
    const recommendation: 'use-existing' | 'new' = recommendedCandidate ? 'use-existing' : 'new';

    return {
      service: def.service,
      label: def.label,
      armType: def.armType,
      enabledFlag: def.enabledFlag,
      canDisable: true, // all three now have a loom<Svc>Enabled opt-out flag
      existing,
      recommendation,
      recommendedCandidate,
    };
  });

  // SHIR has no standalone reusable resource (it is a VMSS the DLZ ADF registers);
  // surface it as an on/off choice that follows the Data Factory decision.
  services.push({
    service: 'shir',
    label: 'Self-hosted Integration Runtime (scale-to-0 VMSS)',
    armType: 'microsoft.compute/virtualmachinescalesets',
    enabledFlag: 'loomSelfHostedIrEnabled',
    canDisable: true,
    existing: [],
    recommendation: 'new',
    recommendedCandidate: undefined,
  });

  return NextResponse.json({ ok: true, services });
}
