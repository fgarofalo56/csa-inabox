/**
 * discovery-model — the PURE half of multi-subscription adoption discovery.
 *
 * Query generation, row → candidate mapping, the per-subscription coverage
 * ledger and the recommendation engine live here so they are unit-testable
 * without a network. `discovery-scanner.ts` owns the credentials and the HTTP.
 *
 * ## The Resource Graph contract, as MEASURED (not as documented)
 *
 * Every claim below was verified live against the Commercial ARG REST endpoint
 * at `api-version=2022-10-01` on 2026-08-05. Several contradict both the docs
 * and the code that was shipped against them:
 *
 * 1. **`resultFormat` defaults to `objectArray` for REST.** Microsoft Learn's
 *    "Table is the default value" is describing the CLI/PowerShell surface, not
 *    the REST API. Probe: `{"query":"Resources | project name | limit 1"}` →
 *    `{"count":1,"data":[{"name":"…"}]}`. We still send it explicitly.
 *
 * 2. **`options.top` is a silent NO-OP; the key is `options.$top`.** Probe:
 *    `options:{top:5}` returned **1000** rows (the default page size);
 *    `options:{$top:5}` returned 5. `app/api/setup/scan-services/route.ts`
 *    has been sending `{top: 1000}` and getting the default by coincidence.
 *
 * 3. **Default page size is 1000 and `$skipToken` is the ONLY truncation
 *    signal.** `resultTruncated` stayed `"false"` on a response that carried a
 *    `$skipToken` and `count` 1000 of `totalRecords` 1201. Code that reads
 *    `resultTruncated` to decide whether it saw everything is reading a field
 *    that does not answer that question.
 *
 * 4. **THE IMPORTANT ONE — a subscription in `subscriptions[]` that the caller
 *    cannot read is DROPPED SILENTLY.** Probe: `subscriptions:[<readable>,
 *    <unreadable>]` returned HTTP 200 with only the readable subscription's
 *    rows and **no indication whatsoever** that the second scope was skipped.
 *    `allowPartialScopes:true` changed nothing — it is about the tenant-scope
 *    subscription-count limit, not about access.
 *
 *    Only when EVERY requested scope is ineligible does ARG fail, with
 *    `BadRequest / NoValidSubscriptionsInQueryRequest`.
 *
 *    So a coverage ledger derived from the query's own results is a LIE: ask
 *    for 12 subscriptions, be unable to read 3, and those 3 look exactly like
 *    "scanned, nothing found". That is the `unknown reported as negative` class
 *    verbatim, and it is why {@link COVERAGE_QUERY} exists — a subscription is
 *    only recorded as `scanned` when ARG itself returned that subscription's
 *    own container row. Never inferred from match counts.
 *
 * 5. **`ResourceContainers` returns a row per subscription the caller can read,
 *    including subscriptions that contain zero resources.** That is what makes
 *    (4)'s ledger possible, and it is the only reason a genuinely empty
 *    greenfield subscription can be distinguished from an unreadable one.
 */

import {
  ADOPTION_CATALOG,
  adoptionArmTypes,
  armTypeToServiceKey,
  getServiceDef,
  type AdoptableServiceDef,
} from './adoption-catalog';

/**
 * The catalog key whose rows carry a meaningful `isHnsEnabled`. Referenced by
 * KEY, never by a second copy of the ARM type string —
 * `scripts/ci/check-adoption-catalog-sync.mjs` rejects any ARM-type literal in
 * this file, and it caught exactly this line on its first run.
 */
const STORAGE_SERVICE_KEY = 'storage-adls';

/** Which credential answered for a given subscription. Surfaced in the UI. */export type CredentialTier =
  /** The signed-in operator's delegated ARM token — their own RBAC + ABAC. */
  | 'user'
  /** The Console user-assigned managed identity. May see less than the operator. */
  | 'uami';

/**
 * What happened when we tried to read one subscription. Built from the
 * REQUESTED list, never inferred from the result rows (see contract note 4).
 */
export type SubscriptionScanStatus =
  /** ARG returned this subscription's own container row — we genuinely read it. */
  | 'scanned'
  /**
   * We could not read it. Either ARM did not list it for this identity, or ARG
   * dropped it from the scoped query. `established` says which.
   */
  | 'no-access'
  /** The paging budget expired before this subscription's rows were exhausted. */
  | 'truncated'
  /** The operator did not include this subscription in the scan scope. */
  | 'not-requested';

export interface SubscriptionScanResult {
  subscriptionId: string;
  /** ARM display name when known; '' when we could not read the subscription. */
  displayName: string;
  status: SubscriptionScanStatus;
  credentialTier: CredentialTier | null;
  /**
   * How many adoption candidates were found here. `0` with
   * `status:'scanned'` is a LEGITIMATE and DIFFERENT answer from `no-access` —
   * these two must never be collapsed in any summary or UI string.
   */
  matchedResources: number;
  /**
   * What the code actually OBSERVED that produced this status. Mandatory: a
   * status may only assert what this field records (deploy-integrity R7).
   */
  established: string;
}

/** Network posture of a candidate, reusing the day-2 attach vocabulary. */
export type CandidateNetworkPosture = 'public' | 'service-endpoint' | 'private-endpoint' | 'unknown';

/** One existing Azure resource Loom could adopt. */
export interface AdoptionCandidate {
  /** Catalog key this candidate is a candidate FOR. */
  serviceKey: string;
  /**
   * Full ARM resource id. Carried for the plan and the RBAC scope, but NEVER
   * rendered in full in the UI or written to a log — use {@link redactArmId}.
   */
  id: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  subscriptionName: string;
  location: string;
  sku: { name?: string; tier?: string };
  kind?: string;
  networkPosture: CandidateNetworkPosture;
  /** Count of private-endpoint connections on the resource (0 when none). */
  privateEndpointCount: number;
  /** ADLS Gen2 hierarchical namespace, for storage rows. undefined elsewhere. */
  hierarchicalNamespace?: boolean;
  tags: Record<string, string>;
  /** true when the resource carries Loom's own deployment tags / RG naming. */
  looksLoomOwned: boolean;
  credentialTier: CredentialTier;
  discoveredAt: string;
}

/**
 * Why a service ended up with no candidate. These three are DISTINCT outcomes
 * and are never merged — "we looked and there is nothing" and "we could not
 * look" lead to different operator actions.
 */
export type NoCandidateOutcome =
  /** Every requested subscription was genuinely scanned and none had one. */
  | 'none-exist'
  /** At least one requested subscription could not be read or was truncated. */
  | 'could-not-look'
  /** Loom always deploys its own — adoption is not offered. */
  | 'not-adoptable';

export type AdoptionRecommendation = 'adopt' | 'create' | 'adopt-required';

/** Per-service discovery result. */
export interface ServiceDiscovery {
  serviceKey: string;
  label: string;
  family: AdoptableServiceDef['family'];
  cls: AdoptableServiceDef['cls'];
  usedFor: string;
  /** What Loom would change about an adopted instance. Rendered on review. */
  mutations: string[];
  /** Present only for create-only services. */
  createOnlyReason?: string;
  candidates: AdoptionCandidate[];
  recommendation: AdoptionRecommendation;
  /** A human sentence. Always present. */
  recommendationReason: string;
  /** Only set when `candidates` is empty. */
  noCandidateOutcome?: NoCandidateOutcome;
  /**
   * true when coverage was incomplete, so "nothing found" is not a conclusion.
   * Drives the "if you have one, point at it" affordance.
   */
  uncertain: boolean;
}

export interface DiscoveryResult {
  /** Per-subscription ledger, one entry per REQUESTED subscription. */
  subscriptions: SubscriptionScanResult[];
  services: ServiceDiscovery[];
  /** Which credential produced the inventory. */
  credentialTier: CredentialTier;
  /** Set when the paging budget stopped the walk early. */
  truncatedBy: 'pages' | 'time' | null;
  scannedAt: string;
  /**
   * A generated one-line summary. Derived from the ledger, never a hard-coded
   * count and never conflating scanned-with-zero and could-not-read.
   */
  summary: string;
}

// ---------------------------------------------------------------------------
// Query generation
// ---------------------------------------------------------------------------

/**
 * The coverage probe: one row per subscription ARG can actually read within the
 * requested scope. This — NOT the inventory result — is what makes a
 * subscription `scanned`. See contract notes 4 and 5.
 */
export const COVERAGE_QUERY = [
  'ResourceContainers',
  "| where type =~ 'microsoft.resources/subscriptions'",
  '| project subscriptionId, subName = name',
  '| order by subName asc',
].join('\n');

/**
 * The single multi-type inventory query. The `type in~ (...)` literal is
 * GENERATED from {@link adoptionArmTypes} so a catalog entry cannot exist
 * without the scanner looking for it.
 *
 * `order by type asc, name asc` is deliberate: if a large tenant does exhaust
 * the paging budget mid-walk, the cut lands inside ONE service rather than
 * alphabetically across all of them — an alphabetical cut silently zeroes whole
 * services at the tail. Type-ordered truncation is still truncation, and the
 * ledger reports it, but it does not manufacture a confident "no candidates"
 * for every service after "m".
 */
export function buildInventoryQuery(): string {
  const types = adoptionArmTypes().map((t) => `'${t}'`).join(', ');
  return [
    'Resources',
    `| where type in~ (${types})`,
    "| extend skuName = tostring(coalesce(sku.name, properties.sku.name, ''))",
    "| extend skuTier = tostring(coalesce(sku.tier, properties.sku.tier, ''))",
    "| extend pna = tostring(coalesce(properties.publicNetworkAccess, ''))",
    "| extend aclDefault = tostring(coalesce(properties.networkAcls.defaultAction, properties.networkRuleSet.defaultAction, ''))",
    '| extend peCount = array_length(todynamic(coalesce(properties.privateEndpointConnections, dynamic([]))))',
    "| extend isHns = tostring(properties.isHnsEnabled)",
    '| join kind=leftouter (',
    '    ResourceContainers',
    "    | where type =~ 'microsoft.resources/subscriptions'",
    '    | project subscriptionId, subName = name',
    '  ) on subscriptionId',
    '| project id, name, type, kind, location, resourceGroup, subscriptionId, subName, skuName, skuTier, pna, aclDefault, peCount, isHns, tags',
    '| order by type asc, name asc',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** One row as ARG projects it from {@link buildInventoryQuery}. */export interface InventoryRow {
  id?: string;
  name?: string;
  type?: string;
  kind?: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  subName?: string;
  skuName?: string;
  skuTier?: string;
  pna?: string;
  aclDefault?: string;
  peCount?: number;
  isHns?: string;
  tags?: Record<string, unknown> | null;
}

/**
 * Reduce a full ARM resource id to its last two segments, for UI and logs.
 * Subscription and tenant ids are never emitted by this helper.
 */
export function redactArmId(id: string): string {
  const parts = (id || '').split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * Derive network posture from the projected ARG fields.
 *
 * Mirrors `lib/azure/attach-preflight.deriveNetworkPosture` exactly — same
 * precedence, same vocabulary — so a candidate's posture at discovery and the
 * same resource's posture at day-2 attach can never disagree. The difference is
 * only the input shape: ARG hands us pre-projected scalars rather than the raw
 * `properties` bag.
 *
 * `unknown` is a real answer. A resource whose RP exposes neither field is NOT
 * assumed public.
 */
export function posturefromRow(row: InventoryRow): CandidateNetworkPosture {
  const pna = String(row.pna ?? '').toLowerCase();
  const acl = String(row.aclDefault ?? '').toLowerCase();
  if (pna === 'disabled') return 'private-endpoint';
  if (acl === 'deny') return 'service-endpoint';
  if (pna === 'enabled') return 'public';
  // Neither field present. A private-endpoint connection is still evidence.
  if ((row.peCount ?? 0) > 0) return 'private-endpoint';
  return 'unknown';
}

/** Loom stamps its own resources with these; used to flag self-owned candidates. */function detectLoomOwned(row: InventoryRow, tags: Record<string, string>): boolean {
  const rg = String(row.resourceGroup ?? '').toLowerCase();
  if (rg.startsWith('rg-csa-loom-')) return true;
  const name = String(row.name ?? '').toLowerCase();
  if (name.includes('csa-loom') || name.includes('-loom-')) return true;
  return Object.keys(tags).some((k) => k.toLowerCase() === 'loom-domain');
}

function normaliseTags(raw: InventoryRow['tags']): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Map one inventory row to an adoption candidate, or null when the row's ARM
 * type + kind combination is not an adoption target (e.g. a Speech-kind
 * Cognitive Services account shares `foundry`'s ARM type but is not Foundry).
 */
export function rowToCandidate(
  row: InventoryRow,
  credentialTier: CredentialTier,
  discoveredAt: string,
): AdoptionCandidate | null {
  const serviceKey = armTypeToServiceKey(String(row.type ?? ''), row.kind);
  if (!serviceKey) return null;
  const tags = normaliseTags(row.tags);
  // Derived from the catalog rather than a literal: a second hard-coded ARM
  // type here is exactly the drift `check-adoption-catalog-sync` exists to
  // block, and it caught this line the first time it ran.
  const isStorage = serviceKey === STORAGE_SERVICE_KEY;
  const hnsRaw = String(row.isHns ?? '').toLowerCase();
  return {
    serviceKey,
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    resourceGroup: String(row.resourceGroup ?? ''),
    subscriptionId: String(row.subscriptionId ?? ''),
    subscriptionName: String(row.subName ?? ''),
    location: String(row.location ?? ''),
    sku: {
      name: row.skuName ? String(row.skuName) : undefined,
      tier: row.skuTier ? String(row.skuTier) : undefined,
    },
    kind: row.kind ? String(row.kind) : undefined,
    networkPosture: posturefromRow(row),
    privateEndpointCount: Number.isFinite(row.peCount) ? Number(row.peCount) : 0,
    // Only storage rows carry a meaningful isHnsEnabled. An absent value on a
    // storage account is `undefined` (unknown), never `false` — HNS is
    // create-time-only, so a wrong `false` would wrongly reject an account.
    hierarchicalNamespace: isStorage && hnsRaw !== '' ? hnsRaw === 'true' : undefined,
    tags,
    looksLoomOwned: detectLoomOwned(row, tags),
    credentialTier,
    discoveredAt,
  };
}

// ---------------------------------------------------------------------------
// Recommendation + no-candidate classification
// ---------------------------------------------------------------------------

export interface RecommendContext {
  /** The region the Loom hub will be deployed into, when known. */
  hubRegion?: string;
  /** true when any requested subscription was not fully read. */
  coverageIncomplete: boolean;
}

/**
 * Decide adopt / create / adopt-required for one service.
 *
 * Deliberately decisive rather than heuristic:
 *   - a tenant singleton with any candidate is `adopt-required` — "create new"
 *     is not offered, because ARM would reject it;
 *   - exactly one candidate in the hub region is `adopt`;
 *   - everything else — including "three candidates, none obviously right" — is
 *     `create`, because guessing among ambiguous candidates in someone else's
 *     production estate is worse than deploying a clean one.
 */
export function recommendFor(
  def: AdoptableServiceDef,
  candidates: AdoptionCandidate[],
  ctx: RecommendContext,
): { recommendation: AdoptionRecommendation; reason: string } {
  if (def.cls === 'create-only') {
    return {
      recommendation: 'create',
      reason: def.createOnlyReason ?? `Loom always deploys its own ${def.label}.`,
    };
  }
  if (def.cls === 'reference-only') {
    // Loom never provisions or mutates a reference-only service; it only reads
    // one the operator points it at. Exactly one candidate is an unambiguous
    // pick. SEVERAL is not — the live Commercial scan found 9 Azure SQL servers
    // and an earlier draft recommended "adopt" while naming none of them, which
    // is a recommendation the operator cannot act on.
    if (candidates.length === 1) {
      return {
        recommendation: 'adopt',
        reason:
          `Loom only reads ${def.label}; it will reference the existing "${candidates[0].name}" ` +
          `and change nothing about it.`,
      };
    }
    if (candidates.length > 1) {
      return {
        recommendation: 'create',
        reason:
          `${candidates.length} existing ${def.label} instances were found. Loom only READS this ` +
          `service and will not pick one for you — select the one you want Loom to reference, or ` +
          `leave it unset and Loom will use its own.`,
      };
    }
    return {
      recommendation: 'create',
      reason: `No existing ${def.label} found. Loom will deploy one it can read.`,
    };
  }
  if (def.singleton === 'tenant' && candidates.length > 0) {
    return {
      recommendation: 'adopt-required',
      reason:
        `${def.label} is a tenant singleton — Azure allows only one per tenant, and deploying a ` +
        `second fails at ARM. Loom will use the existing "${candidates[0].name}".`,
    };
  }
  if (candidates.length === 0) {
    return {
      recommendation: 'create',
      reason: ctx.coverageIncomplete
        ? `No existing ${def.label} was found, but the scan could not read every subscription you selected. ` +
          `Loom will deploy one — or point at yours if you have it.`
        : `No existing ${def.label} found in the subscriptions scanned. Loom will deploy one.`,
    };
  }
  if (candidates.length === 1) {
    const c = candidates[0];
    const regionOk = !ctx.hubRegion || !c.location || c.location.toLowerCase() === ctx.hubRegion.toLowerCase();
    if (regionOk) {
      return {
        recommendation: 'adopt',
        reason: `One existing ${def.label} found ("${c.name}" in ${c.location || 'an unreported region'}). Loom will use it.`,
      };
    }
    return {
      recommendation: 'create',
      reason:
        `The one existing ${def.label} ("${c.name}") is in ${c.location}, not the hub region ` +
        `${ctx.hubRegion}. Loom will deploy one in-region — adopt it instead if the cross-region ` +
        `latency and egress are acceptable.`,
    };
  }
  return {
    recommendation: 'create',
    reason:
      `${candidates.length} existing ${def.label} instances were found and none is unambiguously the ` +
      `right one. Loom will deploy a new one — pick one above to adopt it instead.`,
  };
}

/**
 * Classify WHY a service has no candidate. The distinction between
 * "none exist" and "could not look" is the whole point: only the first is a
 * conclusion.
 */
export function classifyNoCandidate(
  def: AdoptableServiceDef,
  coverageIncomplete: boolean,
): NoCandidateOutcome {
  if (def.cls === 'create-only') return 'not-adoptable';
  return coverageIncomplete ? 'could-not-look' : 'none-exist';
}

/**
 * Assemble the per-service view from the flat candidate list plus the coverage
 * ledger. `coverageIncomplete` is computed from the LEDGER, so a service is
 * only ever told "nothing exists" when every requested subscription was
 * genuinely read.
 */
export function buildServiceDiscoveries(
  candidates: AdoptionCandidate[],
  ledger: SubscriptionScanResult[],
  ctx: { hubRegion?: string },
): ServiceDiscovery[] {
  const coverageIncomplete = ledger.some(
    (s) => s.status === 'no-access' || s.status === 'truncated',
  );
  const byKey = new Map<string, AdoptionCandidate[]>();
  for (const c of candidates) {
    if (!byKey.has(c.serviceKey)) byKey.set(c.serviceKey, []);
    byKey.get(c.serviceKey)!.push(c);
  }
  const rctx: RecommendContext = { hubRegion: ctx.hubRegion, coverageIncomplete };
  return ADOPTION_CATALOG.map((def) => {
    // A create-only service is never offered a candidate even if instances of
    // its ARM type exist — showing one implies a choice that does not exist.
    const found = def.cls === 'create-only' ? [] : byKey.get(def.key) ?? [];
    const { recommendation, reason } = recommendFor(def, found, rctx);
    return {
      serviceKey: def.key,
      label: def.label,
      family: def.family,
      cls: def.cls,
      usedFor: def.usedFor,
      mutations: def.mutations,
      createOnlyReason: def.createOnlyReason,
      candidates: found,
      recommendation,
      recommendationReason: reason,
      noCandidateOutcome: found.length === 0 ? classifyNoCandidate(def, coverageIncomplete) : undefined,
      uncertain: found.length === 0 && coverageIncomplete && def.cls !== 'create-only',
    };
  });
}

/**
 * Generate the coverage summary line.
 *
 * Never hard-codes a count, and never lets `scanned with 0 matches` and
 * `could not read` collapse into one number — the old
 * `subscriptionsScanned: subsSeen.size` counted only subscriptions that
 * happened to contain a match, so an operator with 12 subscriptions and hits in
 * 2 was told "2 subscriptions scanned". That was an untrue statement about
 * coverage, and it is the sentence this function replaces.
 */
export function summariseCoverage(ledger: SubscriptionScanResult[]): string {
  const requested = ledger.length;
  const scanned = ledger.filter((s) => s.status === 'scanned').length;
  const noAccess = ledger.filter((s) => s.status === 'no-access').length;
  const truncated = ledger.filter((s) => s.status === 'truncated').length;
  const withMatches = ledger.filter((s) => s.status === 'scanned' && s.matchedResources > 0).length;

  const parts = [`Requested ${requested} subscription${requested === 1 ? '' : 's'}.`];
  parts.push(
    `Read ${scanned}${scanned === 1 ? '' : ''} of them` +
      (scanned > 0 ? `, ${withMatches} containing something Loom could adopt.` : '.'),
  );
  if (noAccess > 0) {
    parts.push(
      `${noAccess} could NOT be read — those are unknown, not empty. Anything you own there ` +
        `will not appear below.`,
    );
  }
  if (truncated > 0) {
    parts.push(
      `${truncated} was cut short by the scan's time budget, so its inventory is incomplete.`,
    );
  }
  if (noAccess === 0 && truncated === 0 && scanned === requested) {
    parts.push('Coverage is complete.');
  }
  return parts.join(' ');
}

/** Re-exported so callers need only one import for the common case. */
export { ADOPTION_CATALOG, getServiceDef };
