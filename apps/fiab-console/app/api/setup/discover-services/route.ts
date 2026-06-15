/**
 * GET /api/setup/discover-services?boundary=<Commercial|GCC|GCC-High|IL5>
 *   The Setup Wizard's pre-deploy scan — the in-console twin of the CLI
 *   `scripts/csa-loom/scan-and-deploy.sh`. For every Loom-integrable Azure
 *   service it scans every subscription the Console identity can see (via Azure
 *   Resource Graph) and returns, per service, the existing candidates plus a
 *   RECOMMENDATION (use-existing / new / disable). The wizard renders a 3-way
 *   choice (Use existing / New / Disable) defaulted to the recommendation, so the
 *   operator confirms the wiring before the deploy — matching the CLI exactly.
 *
 *   Default posture is everything-ON (opt-out, per the deploy-readiness PRP):
 *     • 0 candidates           → recommend NEW (provision a fresh instance).
 *     • exactly 1 candidate    → recommend USE-EXISTING (reuse it).
 *     • >1 candidates          → recommend NEW (ambiguous; operator picks).
 *     • Purview (singleton)    → recommend USE-EXISTING whenever ANY tenant
 *       instance exists (only one Enterprise Purview is allowed per tenant —
 *       "EnterpriseTenantAlreadyExists").
 *     • Azure Maps on GCC-High/IL5 → recommend DISABLE (Maps is unavailable in
 *       those Gov clouds; the Geo editors run in their honest-gate state).
 *
 *   This route is the UNION of the comprehensive scan-and-choose CLI twin
 *   (every Loom-integrable service, Resource Graph) and the networking/API
 *   domain scan (APIM · Azure Maps · Key Vault · hub Azure Firewall). The
 *   response therefore carries BOTH field shapes per service so both the
 *   primary "Scan & choose" surface (SetupServiceChoices — candidates / envVars
 *   / recommendedCandidate) and the networking ServiceScanPanel (existing /
 *   recommendationReason / allowExisting / allowDisable) read the same payload.
 *
 *   The service set + the canonical EXISTING_* env names mirror the CLI's
 *   SERVICES table and scripts/csa-loom/discover-services.sh, so the wizard's
 *   choices source cleanly into patch-navigator-env.sh / grant-navigator-rbac.sh
 *   on the reuse path. No mock data — when the principal can see no instances,
 *   the candidate list is genuinely empty and the recommendation is NEW
 *   (per .claude/rules/no-vaporware.md).
 *
 *   ARM/Resource Graph honours RBAC: only resources in scopes where the Console
 *   identity has at least Reader come back. When Graph is unreachable (the
 *   identity has no Reader anywhere, or the provider isn't registered) the route
 *   returns an honest 503 with code:'not_configured' and the exact remediation.
 *
 * Gated on the `admin.deploy-dlz` capability (Admin) — same gate as the deploy
 * route, since this drives a subscription-scoped deployment plan.
 *
 * Response shape:
 *   { ok: true, boundary, subscriptionsScanned, services: [{
 *       service, key, label, armType, enableFlag, enabledFlag,
 *       recommendation: 'new'|'use-existing'|'disable',
 *       recommendationReason, allowExisting, allowDisable,
 *       recommendedCandidate: number|null,          // 1-based index into candidates
 *       candidates: [{ name, rg, sub, region }],
 *       existing:   [{ name, resourceGroup, subscriptionId, location }],
 *       envVars: { name, rg, sub },                  // canonical EXISTING_* names
 *     }] }
 *   { ok: false, error, code?, missing?, hint? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
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

interface ServiceSpec {
  /** Stable key (matches the CLI SERVICES table). */
  service: string;
  /** Human label for the wizard row. */
  label: string;
  /** ARM resource type queried in Resource Graph. null → pseudo-service (e.g. hub Firewall, on/off only). */
  armType: string | null;
  /** Optional extra KQL predicate (e.g. AOAI kind filter). */
  filter?: string;
  /** main.bicep `loom<Svc>Enabled`-style flag, or null for DLZ-provisioned services. */
  enableFlag: string | null;
  /** Canonical EXISTING_* env var triple shared with the CLI + post-deploy scripts. */
  envVars: { name: string; rg: string; sub: string };
  /** Only one instance allowed per tenant → always recommend reuse when any exists. */
  singleton?: boolean;
  /** Whether the operator may pick "use existing" for this service (false → foundational, shown for context only). */
  allowExisting?: boolean;
  /** Human reason shown by the networking ServiceScanPanel. */
  reason?: string;
}

/**
 * The Loom-integrable service set. Mirrors the SERVICES table in
 * scripts/csa-loom/scan-and-deploy.sh (same ARM types, same EXISTING_* names,
 * same enable flags) so the CLI and the wizard scan stay one-for-one. The
 * networking/API domain (APIM · Maps · Key Vault) carries its richer reason +
 * reuse metadata; the hub Azure Firewall is appended as an on/off pseudo-service.
 */
const SERVICES: ServiceSpec[] = [
  { service: 'aisearch', label: 'AI Search', armType: 'Microsoft.Search/searchServices', enableFlag: 'aiSearchEnabled', envVars: { name: 'EXISTING_AI_SEARCH_SERVICE', rg: 'EXISTING_AI_SEARCH_RG', sub: 'EXISTING_AI_SEARCH_SUB' }, reason: 'Backs the AI Search / vector navigators. ON by default — reuse an existing service to skip provisioning.' },
  { service: 'apim', label: 'API Management', armType: 'Microsoft.ApiManagement/service', enableFlag: 'apimEnabled', envVars: { name: 'EXISTING_APIM', rg: 'EXISTING_APIM_RG', sub: 'EXISTING_APIM_SUB' }, reason: 'Backs the API Marketplace (publish / Try / curl). ON by default — provisioning Premium takes ~30 min. Reuse an existing APIM to skip provisioning.' },
  { service: 'adx', label: 'ADX / Kusto', armType: 'Microsoft.Kusto/clusters', enableFlag: 'adxEnabled', envVars: { name: 'EXISTING_KUSTO_CLUSTER', rg: 'EXISTING_KUSTO_RG', sub: 'EXISTING_KUSTO_SUB' }, reason: 'Backs the Real-Time Intelligence editors (Eventhouse, KQL DB/Queryset/Dashboard). ON by default. Reuse an existing cluster to skip the Dev-SKU cost.' },
  { service: 'foundry', label: 'AI Foundry / AOAI', armType: 'Microsoft.CognitiveServices/accounts', filter: "kind =~ 'AIServices'", enableFlag: 'aiFoundryEnabled', envVars: { name: 'EXISTING_AOAI', rg: 'EXISTING_AOAI_RG', sub: 'EXISTING_AOAI_SUB' }, reason: 'Backs the Copilot + AI Foundry agent/orchestration surfaces. ON by default. Reuse an existing AIServices account to skip provisioning.' },
  { service: 'purview', label: 'Microsoft Purview', armType: 'Microsoft.Purview/accounts', enableFlag: 'purviewEnabled', singleton: true, envVars: { name: 'EXISTING_PURVIEW', rg: 'EXISTING_PURVIEW_RG', sub: 'EXISTING_PURVIEW_SUB' }, reason: 'Backs governance / data-map. Only ONE Enterprise Purview is allowed per tenant — reuse the existing one when present ("EnterpriseTenantAlreadyExists").' },
  { service: 'maps', label: 'Azure Maps', armType: 'Microsoft.Maps/accounts', enableFlag: 'azureMapsEnabled', envVars: { name: 'EXISTING_MAPS', rg: 'EXISTING_MAPS_RG', sub: 'EXISTING_MAPS_SUB' }, reason: 'Backs the Geo / map editors. ON by default on Commercial / GCC. Reuse binds an existing account (name + key only). Unavailable in GCC-High / IL5.' },
  { service: 'synapse', label: 'Synapse', armType: 'Microsoft.Synapse/workspaces', enableFlag: null, envVars: { name: 'EXISTING_SYNAPSE', rg: 'EXISTING_SYNAPSE_RG', sub: 'EXISTING_SYNAPSE_SUB' }, reason: 'Per-DLZ Synapse (Serverless + dedicated + Spark). Provisioned with the platform; reuse an existing workspace if you have one.' },
  { service: 'cosmos', label: 'Cosmos DB', armType: 'Microsoft.DocumentDB/databaseAccounts', enableFlag: null, envVars: { name: 'EXISTING_COSMOS_ACCOUNT', rg: 'EXISTING_COSMOS_ACCOUNT_RG', sub: 'EXISTING_COSMOS_ACCOUNT_SUB' }, reason: 'Console metadata + graph/vector store. Provisioned with the platform; reuse an existing account to skip provisioning.' },
  { service: 'adf', label: 'Data Factory', armType: 'Microsoft.DataFactory/factories', enableFlag: null, envVars: { name: 'EXISTING_ADF', rg: 'EXISTING_ADF_RG', sub: 'EXISTING_ADF_SUB' }, reason: 'Per-DLZ Data Factory (pipelines / dataflows). Provisioned with the platform; reuse an existing factory if you have one.' },
  { service: 'eventhubs', label: 'Event Hubs', armType: 'Microsoft.EventHub/namespaces', enableFlag: null, envVars: { name: 'EXISTING_EVENTHUB_NAMESPACE', rg: 'EXISTING_EVENTHUB_RG', sub: 'EXISTING_EVENTHUB_SUB' }, reason: 'Backs Eventstream sources, Data Explorer receive, Mirroring CDC transport. Provisioned with the platform; reuse an existing namespace if you have one.' },
  { service: 'databricks', label: 'Databricks', armType: 'Microsoft.Databricks/workspaces', enableFlag: null, envVars: { name: 'EXISTING_DATABRICKS', rg: 'EXISTING_DATABRICKS_RG', sub: 'EXISTING_DATABRICKS_SUB' }, reason: 'Per-DLZ Databricks (+ Unity Catalog). Provisioned with the platform; reuse an existing workspace if you have one.' },
  { service: 'storage', label: 'Storage / ADLS Gen2', armType: 'Microsoft.Storage/storageAccounts', enableFlag: null, envVars: { name: 'EXISTING_STORAGE', rg: 'EXISTING_STORAGE_RG', sub: 'EXISTING_STORAGE_SUB' }, reason: 'Backs the medallion lakehouse + Org visuals. Provisioned with the platform; reuse an existing HNS account if you have one.' },
  { service: 'postgres', label: 'PostgreSQL Flexible', armType: 'Microsoft.DBforPostgreSQL/flexibleServers', enableFlag: 'postgresEnabled', envVars: { name: 'EXISTING_POSTGRES', rg: 'EXISTING_POSTGRES_RG', sub: 'EXISTING_POSTGRES_SUB' }, reason: 'Backs the Postgres-flavored stores. ON by default. Reuse an existing flexible server to skip provisioning.' },
  { service: 'keyvault', label: 'Key Vault', armType: 'Microsoft.KeyVault/vaults', enableFlag: null, allowExisting: false, envVars: { name: 'EXISTING_KEYVAULT', rg: 'EXISTING_KEYVAULT_RG', sub: 'EXISTING_KEYVAULT_SUB' }, reason: 'FOUNDATIONAL — always provisioned new. Stores the MSAL secret, SESSION_SECRET, the Azure Maps key, and the Loom Connections credential store, so it can never be a not_configured gate. Reuse/disable are intentionally not offered.' },
  { service: 'firewall', label: 'Hub Azure Firewall', armType: null, enableFlag: 'loomFirewallEnabled', allowExisting: false, envVars: { name: 'EXISTING_FIREWALL', rg: 'EXISTING_FIREWALL_RG', sub: 'EXISTING_FIREWALL_SUB' }, reason: 'Egress hardening for the admin plane. ON by default — on/off only (no reuse). Disable to skip the cost and the FirewallPolicyUpdateFailed reconcile edge case.' },
];

interface Candidate {
  name: string;
  rg: string;
  sub: string;
  region: string;
}

/** Networking ServiceScanPanel's existing-resource shape. */
interface ExistingResource {
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location?: string;
}

type Recommendation = 'new' | 'use-existing' | 'disable';

interface ServiceScan {
  service: string;
  /** Alias of `service` — networking ServiceScanPanel keys on `key`. */
  key: string;
  label: string;
  armType: string | null;
  enableFlag: string | null;
  /** Alias of `enableFlag` — networking ServiceScanPanel reads `enabledFlag`. */
  enabledFlag: string | null;
  recommendation: Recommendation;
  recommendationReason: string;
  allowExisting: boolean;
  allowDisable: boolean;
  recommendedCandidate: number | null;
  candidates: Candidate[];
  /** Alias of `candidates` in the networking ServiceScanPanel shape. */
  existing: ExistingResource[];
  envVars: { name: string; rg: string; sub: string };
}

/** One Resource Graph query covering every real service type, grouped by type. */
function buildGraphQuery(): string {
  const types = SERVICES.filter((s) => s.armType)
    .map((s) => `'${s.armType!.toLowerCase()}'`)
    .join(', ');
  // Project the columns the wizard needs; lower(type) so the in-memory grouping
  // is case-insensitive. AOAI's kind filter is applied in-memory (the shared
  // query returns all Cognitive accounts; we keep only AIServices for foundry).
  return (
    `Resources | where type in~ (${types}) ` +
    '| project name, resourceGroup, subscriptionId, location, rtype = tolower(type), kind ' +
    '| order by name asc'
  );
}

function recommend(
  spec: ServiceSpec,
  candidates: Candidate[],
  isGov: boolean,
): { recommendation: Recommendation; recommendedCandidate: number | null } {
  // Azure Maps is unavailable in GCC-High / IL5 → recommend leaving it disabled.
  if (spec.service === 'maps' && isGov) return { recommendation: 'disable', recommendedCandidate: null };
  if (spec.allowExisting === false) return { recommendation: 'new', recommendedCandidate: null };
  if (spec.singleton && candidates.length >= 1) return { recommendation: 'use-existing', recommendedCandidate: 1 };
  if (candidates.length === 1) return { recommendation: 'use-existing', recommendedCandidate: 1 };
  // 0 candidates → new; >1 ambiguous → new (operator overrides).
  return { recommendation: 'new', recommendedCandidate: null };
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Same gate as POST /api/setup/deploy — this builds a subscription-scoped
  // deployment plan, so it's an admin-tier action.
  const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
  if (gate) return gate;

  const boundary = req.nextUrl.searchParams.get('boundary') || 'Commercial';
  const isGov = boundary === 'GCC-High' || boundary === 'IL5';

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
        code: 'not_configured',
        missing: ['ARM Reader for the Console identity'],
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI Reader on the subscriptions you want the scan to cover.',
      },
      { status: 503 },
    );
  }

  let rows: any[];
  try {
    const res = await fetch(`${arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: buildGraphQuery() }),
      cache: 'no-store',
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return NextResponse.json(
        {
          ok: false,
          error: `Resource Graph ${res.status}: ${t.slice(0, 200)}`,
          code: 'not_configured',
          missing: ['Microsoft.ResourceGraph access (Reader on at least one subscription)'],
          hint: 'Grant the Console UAMI Reader on the subscriptions to scan, or run scripts/csa-loom/scan-and-deploy.sh locally with az login.',
        },
        { status: 503 },
      );
    }
    const j: any = await res.json();
    rows = (j?.data || []) as any[];
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `Resource Graph request failed: ${e?.message ?? String(e)}`,
        code: 'not_configured',
        hint: 'The Console could not reach Azure Resource Graph. Confirm network egress + the Console UAMI has Reader on the target subscriptions.',
      },
      { status: 503 },
    );
  }

  // Group the rows by lowercased ARM type, then map each service onto its
  // candidates + recommendation. Also count distinct subscriptions seen.
  const byType = new Map<string, any[]>();
  const subsSeen = new Set<string>();
  for (const row of rows) {
    const t = String(row.rtype || '').toLowerCase();
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(row);
    if (row.subscriptionId) subsSeen.add(String(row.subscriptionId));
  }

  const services: ServiceScan[] = SERVICES.map((spec) => {
    let raw = spec.armType ? byType.get(spec.armType.toLowerCase()) || [] : [];
    // AOAI: the shared query returns every Cognitive account; keep only AIServices.
    if (spec.filter && /AIServices/i.test(spec.filter)) {
      raw = raw.filter((r) => /AIServices/i.test(String(r.kind || '')));
    }
    const candidates: Candidate[] = raw.map((r) => ({
      name: r.name,
      rg: r.resourceGroup || '',
      sub: r.subscriptionId || '',
      region: r.location || '',
    }));
    const { recommendation, recommendedCandidate } = recommend(spec, candidates, isGov);
    const allowExisting = spec.allowExisting !== false && spec.armType !== null;
    const allowDisable = spec.enableFlag !== null;
    return {
      service: spec.service,
      key: spec.service,
      label: spec.label,
      armType: spec.armType,
      enableFlag: spec.enableFlag,
      enabledFlag: spec.enableFlag,
      recommendation,
      recommendationReason: spec.reason || '',
      allowExisting,
      allowDisable,
      recommendedCandidate,
      candidates,
      existing: candidates.map((c) => ({
        name: c.name,
        resourceGroup: c.rg,
        subscriptionId: c.sub,
        location: c.region,
      })),
      envVars: spec.envVars,
    };
  });

  return NextResponse.json({ ok: true, boundary, subscriptionsScanned: subsSeen.size, services });
}
