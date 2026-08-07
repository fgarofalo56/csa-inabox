/**
 * GET /api/setup/discover-services?boundary=<Commercial|GCC|GCC-High|IL5>
 *   The Setup Wizard's pre-deploy scan — the in-console twin of the CLI
 *   `scripts/csa-loom/scan-and-deploy.sh`. For every Loom-integrable Azure
 *   service it returns the existing candidates plus a RECOMMENDATION
 *   (use-existing / new / disable) the wizard renders as a 3-way choice.
 *
 *   ## One scanner, not three (#3015)
 *
 *   This route previously ran its OWN raw Resource Graph query: no `$top` (the
 *   earlier sibling sent the no-op `top`), no `$skipToken` loop (silent
 *   truncation past 1000 rows, cut ALPHABETICALLY), no `allowPartialScopes`,
 *   and a `subscriptionsScanned` counted from MATCHED ROWS — an operator with
 *   12 subscriptions and hits in 2 was told "2 scanned", and an unreadable
 *   subscription was indistinguishable from an empty one.
 *
 *   It now delegates to `lib/deploy/discovery-scanner` — the SAME module behind
 *   `POST /api/deploy/discovery` — which does the three-step honest scan:
 *   ARM `GET /subscriptions` (what can this identity see), the ARG coverage
 *   probe (what will ARG actually read), then the paged inventory scoped to
 *   proven-readable subscriptions only. The response therefore carries a
 *   per-subscription coverage LEDGER, and `subscriptionsScanned` is the number
 *   of subscriptions genuinely READ — never inferred from result rows.
 *
 *   Credential ladder: signed-in operator first, Console UAMI second (at first
 *   run the operator is typically Owner while the UAMI may not exist yet).
 *
 *   The service set + the canonical EXISTING_* env names mirror the CLI's
 *   SERVICES table and scripts/csa-loom/discover-services.sh, so the wizard's
 *   choices source cleanly into patch-navigator-env.sh / grant-navigator-rbac.sh
 *   on the reuse path. No mock data — when nothing is visible the candidate
 *   lists are honestly empty WITH the ledger saying what was and was not read
 *   (per .claude/rules/no-vaporware.md and deploy-integrity.md R7).
 *
 * Gated on the `admin.deploy-dlz` capability (Admin) — same gate as the deploy
 * route, since this drives a subscription-scoped deployment plan.
 *
 * Response shape (superset of the previous one — both consumer panels keep
 * their fields, plus the honest coverage additions):
 *   { ok: true, boundary, subscriptionsScanned, coverage, ledger, truncatedBy,
 *     services: [{
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
import { enforceCapability } from '@/lib/auth/feature-gate';
import {
  acquireCredentials,
  scanForAdoptionCandidates,
} from '@/lib/deploy/discovery-scanner';
import type { ServiceDiscovery } from '@/lib/deploy/discovery-model';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ServiceSpec {
  /** Stable key (matches the CLI SERVICES table). */
  service: string;
  /** Adoption-catalog key when it differs from the CLI key. */
  catalogKey?: string;
  /** Human label for the wizard row. */
  label: string;
  /** ARM resource type queried. null → pseudo-service (e.g. hub Firewall, on/off only). */
  armType: string | null;
  /** main.bicep `loom<Svc>Enabled`-style flag, or null for DLZ-provisioned services. */
  enableFlag: string | null;
  /** Canonical EXISTING_* env var triple shared with the CLI + post-deploy scripts. */
  envVars: { name: string; rg: string; sub: string };
  /** Only one instance allowed per tenant → always recommend reuse when any exists. */
  singleton?: boolean;
  /** Whether the operator may pick "use existing" (false → foundational, context only). */
  allowExisting?: boolean;
  /** Human reason shown by the networking ServiceScanPanel. */
  reason?: string;
}

/**
 * The Loom-integrable service set. Mirrors the SERVICES table in
 * scripts/csa-loom/scan-and-deploy.sh (same ARM types, same EXISTING_* names,
 * same enable flags) so the CLI and the wizard scan stay one-for-one. The
 * CANDIDATES per service now come from the shared discovery scanner (keyed by
 * `catalogKey ?? service` into the adoption catalog); this table carries the
 * wizard-facing metadata the catalog does not (env names, enable flags,
 * networking reasons, the on/off firewall pseudo-service).
 */
const SERVICES: ServiceSpec[] = [
  { service: 'aisearch', label: 'AI Search', armType: 'Microsoft.Search/searchServices', enableFlag: 'aiSearchEnabled', envVars: { name: 'EXISTING_AI_SEARCH_SERVICE', rg: 'EXISTING_AI_SEARCH_RG', sub: 'EXISTING_AI_SEARCH_SUB' }, reason: 'Backs the AI Search / vector navigators. ON by default — reuse an existing service to skip provisioning.' },
  { service: 'apim', label: 'API Management', armType: 'Microsoft.ApiManagement/service', enableFlag: 'apimEnabled', envVars: { name: 'EXISTING_APIM', rg: 'EXISTING_APIM_RG', sub: 'EXISTING_APIM_SUB' }, reason: 'Backs the API Marketplace (publish / Try / curl). ON by default — provisioning Premium takes ~30 min. Reuse an existing APIM to skip provisioning.' },
  { service: 'adx', label: 'ADX / Kusto', armType: 'Microsoft.Kusto/clusters', enableFlag: 'adxEnabled', envVars: { name: 'EXISTING_KUSTO_CLUSTER', rg: 'EXISTING_KUSTO_RG', sub: 'EXISTING_KUSTO_SUB' }, reason: 'Backs the Real-Time Intelligence editors (Eventhouse, KQL DB/Queryset/Dashboard). ON by default. Reuse an existing cluster to skip the Dev-SKU cost.' },
  { service: 'foundry', label: 'AI Foundry / AOAI', armType: 'Microsoft.CognitiveServices/accounts', enableFlag: 'aiFoundryEnabled', envVars: { name: 'EXISTING_AOAI', rg: 'EXISTING_AOAI_RG', sub: 'EXISTING_AOAI_SUB' }, reason: 'Backs the Copilot + AI Foundry agent/orchestration surfaces. ON by default. Reuse an existing AIServices account to skip provisioning.' },
  { service: 'purview', label: 'Microsoft Purview', armType: 'Microsoft.Purview/accounts', enableFlag: 'purviewEnabled', singleton: true, envVars: { name: 'EXISTING_PURVIEW', rg: 'EXISTING_PURVIEW_RG', sub: 'EXISTING_PURVIEW_SUB' }, reason: 'Backs governance / data-map. Only ONE Enterprise Purview is allowed per tenant — reuse the existing one when present ("EnterpriseTenantAlreadyExists").' },
  { service: 'maps', label: 'Azure Maps', armType: 'Microsoft.Maps/accounts', enableFlag: 'azureMapsEnabled', envVars: { name: 'EXISTING_MAPS', rg: 'EXISTING_MAPS_RG', sub: 'EXISTING_MAPS_SUB' }, reason: 'Backs the Geo / map editors. ON by default on Commercial / GCC. Reuse binds an existing account (name + key only). Unavailable in GCC-High / IL5.' },
  { service: 'synapse', label: 'Synapse', armType: 'Microsoft.Synapse/workspaces', enableFlag: null, envVars: { name: 'EXISTING_SYNAPSE', rg: 'EXISTING_SYNAPSE_RG', sub: 'EXISTING_SYNAPSE_SUB' }, reason: 'Per-DLZ Synapse (Serverless + dedicated + Spark). Provisioned with the platform; reuse an existing workspace if you have one.' },
  { service: 'cosmos', label: 'Cosmos DB', armType: 'Microsoft.DocumentDB/databaseAccounts', enableFlag: null, envVars: { name: 'EXISTING_COSMOS_ACCOUNT', rg: 'EXISTING_COSMOS_ACCOUNT_RG', sub: 'EXISTING_COSMOS_ACCOUNT_SUB' }, reason: 'Console metadata + graph/vector store. Provisioned with the platform; reuse an existing account to skip provisioning.' },
  { service: 'adf', label: 'Data Factory', armType: 'Microsoft.DataFactory/factories', enableFlag: null, envVars: { name: 'EXISTING_ADF', rg: 'EXISTING_ADF_RG', sub: 'EXISTING_ADF_SUB' }, reason: 'Per-DLZ Data Factory (pipelines / dataflows). Provisioned with the platform; reuse an existing factory if you have one.' },
  { service: 'eventhubs', label: 'Event Hubs', armType: 'Microsoft.EventHub/namespaces', enableFlag: 'loomEventHubEnabled', envVars: { name: 'EXISTING_EVENTHUB_NAMESPACE', rg: 'EXISTING_EVENTHUB_RG', sub: 'EXISTING_EVENTHUB_SUB' }, reason: 'Backs Eventstream sources, Data Explorer receive, Mirroring CDC transport. ON by default — reuse an existing namespace to skip provisioning, or disable to skip the namespace cost (the Eventstream / Data Explorer navigators then honest-gate).' },
  { service: 'streamanalytics', label: 'Stream Analytics', armType: 'Microsoft.StreamAnalytics/streamingjobs', enableFlag: 'loomStreamAnalyticsEnabled', envVars: { name: 'EXISTING_ASA_JOB', rg: 'EXISTING_ASA_RG', sub: 'EXISTING_ASA_SUB' }, reason: 'Backs the stream-analytics-job editor + the Eventstream transform node. ON by default — reuse an existing job, or disable to skip the streaming-units cost (the editor then honest-gates on LOOM_ASA_RG).' },
  { service: 'databricks', label: 'Databricks', armType: 'Microsoft.Databricks/workspaces', enableFlag: null, envVars: { name: 'EXISTING_DATABRICKS', rg: 'EXISTING_DATABRICKS_RG', sub: 'EXISTING_DATABRICKS_SUB' }, reason: 'Per-DLZ Databricks (+ Unity Catalog). Provisioned with the platform; reuse an existing workspace if you have one.' },
  { service: 'storage', catalogKey: 'storage-adls', label: 'Storage / ADLS Gen2', armType: 'Microsoft.Storage/storageAccounts', enableFlag: null, envVars: { name: 'EXISTING_STORAGE', rg: 'EXISTING_STORAGE_RG', sub: 'EXISTING_STORAGE_SUB' }, reason: 'Backs the medallion lakehouse + Org visuals. Provisioned with the platform; reuse an existing HNS account if you have one.' },
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

export const GET = withSession(async (req: NextRequest, { session }) => {

  // Same gate as POST /api/setup/deploy — this builds a subscription-scoped
  // deployment plan, so it's an admin-tier action.
  const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
  if (gate) return gate;

  const boundary = req.nextUrl.searchParams.get('boundary') || 'Commercial';
  const isGov = boundary === 'GCC-High' || boundary === 'IL5';

  // THE shared scanner (#3015): operator-token-first credential ladder, ARM
  // visibility step, ARG coverage probe, paged `$top`/`$skipToken` inventory
  // with `allowPartialScopes` — identical engine to POST /api/deploy/discovery.
  // An empty subscription list scans everything the identity can see, which is
  // this route's contract (the wizard's scoped scan is /api/setup/estate-scan).
  const creds = await acquireCredentials(session.claims?.oid);
  const outcome = await scanForAdoptionCandidates({ subscriptions: [] }, creds);

  if (!outcome.ok) {
    // Honest 503: the scan could not LOOK. `established` says what the code
    // actually observed — this is never rendered as an empty estate.
    return NextResponse.json(
      {
        ok: false,
        error: outcome.error,
        code: outcome.code === 'no_identity' ? 'not_configured' : outcome.code,
        missing: ['Reader for the scanning identity on the subscriptions to cover'],
        hint: outcome.established,
      },
      { status: 503 },
    );
  }

  const discovered = new Map<string, ServiceDiscovery>(
    outcome.result.services.map((s) => [s.serviceKey, s]),
  );

  const services: ServiceScan[] = SERVICES.map((spec) => {
    const disc = spec.armType ? discovered.get(spec.catalogKey ?? spec.service) : undefined;
    const candidates: Candidate[] = (disc?.candidates ?? []).map((c) => ({
      name: c.name,
      rg: c.resourceGroup,
      sub: c.subscriptionId,
      region: c.location || '',
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

  // COVERAGE, from the ledger — never from matched rows. The previous
  // `subscriptionsScanned: subsSeen.size` counted subscriptions that happened
  // to contain a match, so 12-subscriptions-with-hits-in-2 read as "2 scanned".
  const ledger = outcome.result.subscriptions;
  const subscriptionsScanned = ledger.filter((s) => s.status === 'scanned').length;

  return NextResponse.json({
    ok: true,
    boundary,
    subscriptionsScanned,
    coverage: outcome.result.summary,
    ledger,
    truncatedBy: outcome.result.truncatedBy,
    credentialTier: outcome.result.credentialTier,
    services,
  });
});
