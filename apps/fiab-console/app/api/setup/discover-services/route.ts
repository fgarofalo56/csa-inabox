/**
 * GET /api/setup/discover-services?boundary=<Commercial|GCC|GCC-High|IL5>
 *
 * Setup-Wizard "scan-and-choose" discovery for the networking/API domain
 * (APIM, Azure Maps, Key Vault, hub Azure Firewall). Mirrors the CLI
 * `scripts/csa-loom/scan-and-deploy.sh` flow inside the console: it enumerates
 * every subscription the Console identity can see (ARM `GET /subscriptions`),
 * then for each reusable service type lists existing instances and returns a
 * per-service choice (use-existing / provision-new / disable) WITH A
 * RECOMMENDATION. The wizard renders these so the operator picks before the
 * follow-on deploy; the default posture is everything ON (opt-out).
 *
 * Read-only: only ARM list calls. Nothing is created. The deploy itself is
 * still driven by /api/setup/deploy (orchestrator / workflow / honest gate).
 *
 * Cloud selection follows LOOM_ARM_ENDPOINT via lib/azure/cloud-endpoints.
 *
 * Response:
 *   { ok: true, boundary, subscriptionsScanned, services: ServiceChoice[] }
 *   { ok: false, error, hint? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function armToken(): Promise<string> {
  const t = await credential.getToken(`${armBase()}/.default`);
  if (!t?.token) throw new Error('Failed to acquire AAD token for ARM');
  return t.token;
}

interface ExistingResource {
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location?: string;
}

type Choice = 'existing' | 'new' | 'disable';

interface ServiceChoice {
  /** Stable service key used by the wizard + the .bicepparam emitter. */
  key: 'apim' | 'maps' | 'keyvault' | 'firewall';
  label: string;
  armType: string | null;
  /** main.bicep flag this maps to (loom<Svc>Enabled / *Enabled). */
  enabledFlag: string | null;
  /** Whether the operator may pick "use existing" / "disable" for this service. */
  allowExisting: boolean;
  allowDisable: boolean;
  existing: ExistingResource[];
  recommendation: Choice;
  recommendationReason: string;
}

const DOMAIN_TYPES: Array<{ key: ServiceChoice['key']; armType: string }> = [
  { key: 'apim', armType: 'Microsoft.ApiManagement/service' },
  { key: 'maps', armType: 'Microsoft.Maps/accounts' },
  { key: 'keyvault', armType: 'Microsoft.KeyVault/vaults' },
];

function rgFromId(id: string): string {
  const m = /\/resourceGroups\/([^/]+)\//i.exec(id || '');
  return m ? m[1] : '';
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const boundary = req.nextUrl.searchParams.get('boundary') || 'Commercial';
  const isGov = boundary === 'GCC-High' || boundary === 'IL5';

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
  const arm = armBase();
  const authHeader = { authorization: `Bearer ${token}` };

  // 1) Enumerate subscriptions (paged).
  const subIds: string[] = [];
  try {
    let url: string | undefined = `${arm}/subscriptions?api-version=2022-12-01`;
    while (url) {
      const r: Response = await fetch(url, { headers: authHeader });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return NextResponse.json({ ok: false, error: `ARM ${r.status}: ${t.slice(0, 200)}` }, { status: 502 });
      }
      const j: any = await r.json();
      for (const s of (j.value || []) as any[]) {
        if (s.state === 'Enabled' || !s.state) subIds.push(s.subscriptionId);
      }
      url = j.nextLink || undefined;
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `ARM subscriptions request failed: ${e?.message ?? String(e)}` }, { status: 502 });
  }

  // 2) Per sub, per domain type, list existing resources (bounded, fault-tolerant).
  const found: Record<string, ExistingResource[]> = { apim: [], maps: [], keyvault: [] };
  const cappedSubs = subIds.slice(0, 60); // bound the fan-out on very large tenants
  for (const subId of cappedSubs) {
    for (const { key, armType } of DOMAIN_TYPES) {
      const u = `${arm}/subscriptions/${subId}/resources?api-version=2021-04-01&$filter=${encodeURIComponent(
        `resourceType eq '${armType}'`,
      )}`;
      try {
        const r = await fetch(u, { headers: authHeader });
        if (!r.ok) continue; // a sub we can't read shouldn't kill the scan
        const j: any = await r.json();
        for (const res of (j.value || []) as any[]) {
          found[key].push({
            name: res.name,
            resourceGroup: rgFromId(res.id),
            subscriptionId: subId,
            location: res.location,
          });
        }
      } catch {
        // transient — skip this (sub,type) pair
      }
    }
  }

  // 3) Build the per-service choice + recommendation.
  const services: ServiceChoice[] = [
    {
      key: 'apim',
      label: 'API Management',
      armType: 'Microsoft.ApiManagement/service',
      enabledFlag: 'loomApimEnabled',
      allowExisting: true,
      allowDisable: true,
      existing: found.apim,
      recommendation: 'new',
      recommendationReason:
        'Backs the API Marketplace (publish / Try / curl). ON by default — provisioning Premium takes ~30 min. Reuse an existing APIM to skip provisioning.',
    },
    {
      key: 'maps',
      label: 'Azure Maps',
      armType: 'Microsoft.Maps/accounts',
      enabledFlag: 'loomMapsEnabled',
      allowExisting: true,
      allowDisable: true,
      existing: found.maps,
      recommendation: isGov ? 'disable' : 'new',
      recommendationReason: isGov
        ? 'Azure Maps is unavailable in GCC-High / IL5 — the Geo editors run in their honest-gate state. Leave disabled.'
        : 'Backs the Geo / map editors. ON by default on Commercial / GCC. Reuse binds an existing account via loomAzureMapsAccount (account name + key only).',
    },
    {
      key: 'keyvault',
      label: 'Key Vault',
      armType: 'Microsoft.KeyVault/vaults',
      enabledFlag: null, // foundational — always provisioned
      allowExisting: false,
      allowDisable: false,
      existing: found.keyvault, // shown for context only; reuse is not offered
      recommendation: 'new',
      recommendationReason:
        'FOUNDATIONAL — always provisioned new. Stores the MSAL secret, SESSION_SECRET, the Azure Maps key, and the Loom Connections credential store, so it can never be a not_configured gate. Reuse/disable are intentionally not offered.',
    },
    {
      key: 'firewall',
      label: 'Hub Azure Firewall',
      armType: null, // hub infra, not a reusable per-instance pick
      enabledFlag: 'loomFirewallEnabled',
      allowExisting: false,
      allowDisable: true,
      existing: [],
      recommendation: 'new',
      recommendationReason:
        'Egress hardening for the admin plane. ON by default — on/off only (no reuse). Disable to skip the cost and the FirewallPolicyUpdateFailed reconcile edge case; nothing consumes it (no forced-tunnel UDR).',
    },
  ];

  return NextResponse.json({
    ok: true,
    boundary,
    subscriptionsScanned: cappedSubs.length,
    services,
  });
}
