/**
 * estate-scan — the multi-subscription adoption scan behind the deployment
 * wizard's discovery step.
 *
 * WHAT IT FIXES (deploy-integrity.md R5.1, R7; design §2.1–§2.4):
 *
 *  1. CONSENT. The old scan fired on `useEffect` mount over the whole tenant.
 *     This one takes an EXPLICIT subscription list — the operator confirms the
 *     scope before a single read happens.
 *
 *  2. THE COVERAGE LIE. `discover-services` reported
 *     `subscriptionsScanned: subsSeen.size`, computed from MATCHED ROWS only.
 *     An operator with 12 subscriptions and hits in 2 was told "2 scanned".
 *     Here, coverage is a per-subscription LEDGER built from the REQUESTED
 *     list, and each entry's status is ESTABLISHED by a real readability probe
 *     (`GET /subscriptions/{id}`) — not inferred from whether rows came back.
 *     `matchedResources: 0, status:'scanned'` and `status:'no-access'` are
 *     different answers and can never collapse into each other.
 *
 *  3. IDENTITY ORDER. The pre-deploy scan used `uamiArmCredential()` with NO
 *     user fallback, while the post-deploy attach routes prefer the user. That
 *     is backwards: at first run the operator is typically Owner across the
 *     estate and the Console UAMI may not exist yet. The ladder here is
 *     operator-OBO first, Console UAMI second, and the answering tier is
 *     REPORTED per subscription so the UI can say "scanned as the Loom
 *     identity — may see less than you do".
 *
 *  4. TRUNCATION. The old query had no `$skipToken` loop and ordered by
 *     `name asc`, so on a large tenant the 1000-row cut was ALPHABETICAL and
 *     whole services silently showed zero candidates. This pages to exhaustion
 *     under a {@link PagingBudget}, orders by `type asc, name asc` so any
 *     residual cut is type-balanced, and REPORTS `truncated` per subscription —
 *     a truncated page never produces a "no candidates" claim.
 *
 *  5. `allowPartialScopes`. Never set before, so a scope above Azure's
 *     subscription limit ERRORED instead of returning partial results.
 *
 * Live-verified against the Commercial tenant while writing this: the ARG REST
 * API at 2022-10-01 returns `objectArray` by DEFAULT (Microsoft Learn's "Table
 * is the default" is wrong for REST), the default page size is 1000, and
 * `$skipToken` is the only truthful truncation signal — `resultTruncated` stays
 * `"false"`. `resultFormat` is set explicitly here anyway so the shape does not
 * depend on an undocumented default.
 */

import { armBase } from '@/lib/azure/cloud-endpoints';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { PagingBudget, PAGE_DEADLINE, type PageDeadline } from '@/lib/azure/paging-budget';
import { adoptionArmTypes, armRowToServiceKey, getServiceDef } from '@/lib/deploy/adoption-catalog';
import type { AdoptionCandidate } from '@/lib/deploy/plan-builder';
import type { SubscriptionScanResult } from '@/lib/deploy/plan-model';

const ARG_API_VERSION = '2022-10-01';
const SUB_API_VERSION = '2022-12-01';

/** Wall clock for the whole ARG walk. Read per request so it can be retuned
 *  for a slow sovereign region without a container restart. */
function argBudgetMs(): number {
  const n = Number(process.env.LOOM_ESTATE_SCAN_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 25_000;
}

/** How many subscriptions one scan may probe. A tenant larger than this is a
 *  legitimate answer ("you selected more than I will probe"), not a silent cut. */
export const MAX_SCAN_SUBSCRIPTIONS = 200;

export interface EstateScanRequest {
  /** The subscriptions the operator CONSENTED to. Required, never inferred. */
  subscriptions: string[];
  /** Optional id → display name, so the ledger never renders a bare GUID. */
  subscriptionNames?: Record<string, string>;
  /** Signed-in operator's object id, used to look up their delegated ARM token. */
  operatorOid?: string;
}

export interface EstateScanResult {
  ledger: SubscriptionScanResult[];
  candidates: AdoptionCandidate[];
  /** Tier that answered the bulk query: 1 = operator, 2 = Console UAMI. */
  queryTier: 1 | 2;
  /** Set when NEITHER credential could run the query at all. */
  fatal?: { code: 'no_credential' | 'graph_unreachable'; message: string };
}

interface ArgRow {
  id?: string;
  name?: string;
  type?: string;
  kind?: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  skuName?: string;
  skuTier?: string;
  peCount?: number;
  publicAccess?: string;
  hasIpRules?: number;
  tags?: Record<string, string>;
}

/** Strip anything that could carry markup or an ARM id into a log line. */
function safe(s: unknown, max = 300): string {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * The single ARG query, built FROM THE CATALOG — never a hand-maintained type
 * list, so a service added to the catalog is scanned for automatically.
 *
 * `order by type asc, name asc`: if the walk is ever cut short the loss is
 * spread across types instead of alphabetically erasing whole services.
 */
export function buildEstateQuery(): string {
  const types = adoptionArmTypes()
    .map((t) => `'${t}'`)
    .join(', ');
  return [
    'Resources',
    `| where type in~ (${types})`,
    "| extend skuName = tostring(sku.name), skuTier = tostring(sku.tier)",
    '| extend peCount = array_length(properties.privateEndpointConnections)',
    '| extend publicAccess = tostring(coalesce(properties.publicNetworkAccess, properties.networkAcls.defaultAction, ""))',
    '| extend hasIpRules = array_length(properties.networkAcls.ipRules)',
    '| project id, name, type, kind, location, resourceGroup, subscriptionId, skuName, skuTier, peCount, publicAccess, hasIpRules, tags',
    '| order by type asc, name asc',
  ].join('\n');
}

/**
 * Derive the network posture from what ARG actually returned.
 *
 * `unknown` is returned when the row carried no posture signal at all — it is
 * NEVER collapsed into `public`. A guessed posture would let the fitness suite
 * declare an unreachable resource usable.
 */
export function derivePosture(row: ArgRow): AdoptionCandidate['networkPosture'] {
  const pe = Number(row.peCount ?? 0);
  if (pe > 0) return 'private-endpoint';
  const pub = (row.publicAccess ?? '').toLowerCase();
  const ipRules = Number(row.hasIpRules ?? 0);
  if (pub === 'disabled' || pub === 'deny') return ipRules > 0 ? 'public-restricted' : 'private-endpoint';
  if (ipRules > 0) return 'public-restricted';
  if (pub === 'enabled' || pub === 'allow') return 'public';
  return 'unknown';
}

async function tokenFor(tier: 1 | 2, operatorOid?: string): Promise<string | null> {
  if (tier === 1) {
    if (!operatorOid) return null;
    try {
      return await getUserArmToken(operatorOid);
    } catch {
      return null;
    }
  }
  try {
    const t = await uamiArmCredential().getToken(`${armBase()}/.default`);
    return t?.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Probe whether a token can READ a subscription.
 *
 * This is the establishment behind every ledger entry. `GET /subscriptions/{id}`
 * returns 200 when the caller holds any read on it and 403/404 when it does not,
 * so "no rows came back" is never used as evidence of no access — which is the
 * UNKNOWN-reported-as-NEGATIVE class this whole file exists to avoid.
 */
async function probeSubscription(
  token: string,
  subscriptionId: string,
  timeoutMs: number,
): Promise<{ readable: true; displayName?: string } | { readable: false; detail: string }> {
  const url = `${armBase()}/subscriptions/${encodeURIComponent(subscriptionId)}?api-version=${SUB_API_VERSION}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }, timeoutMs);
    if (res.ok) {
      const j: any = await res.json().catch(() => ({}));
      return { readable: true, displayName: typeof j?.displayName === 'string' ? j.displayName : undefined };
    }
    return { readable: false, detail: `Azure Resource Manager answered HTTP ${res.status} for this subscription.` };
  } catch (e: any) {
    return { readable: false, detail: `The readability probe did not complete: ${safe(e?.message ?? e, 160)}` };
  }
}

/**
 * Run the estate scan.
 *
 * Returns a ledger with one entry per REQUESTED subscription (invariant 3 of
 * plan-model) plus every candidate found. It never throws for an Azure-side
 * problem: an unreachable Graph is a `fatal` field the caller renders honestly,
 * because a thrown error higher up reads as "nothing found".
 */
export async function scanEstate(req: EstateScanRequest): Promise<EstateScanResult> {
  const requested = Array.from(new Set(req.subscriptions.filter((s) => typeof s === 'string' && s.trim()))).slice(
    0,
    MAX_SCAN_SUBSCRIPTIONS,
  );
  const names = req.subscriptionNames ?? {};

  if (requested.length === 0) {
    return { ledger: [], candidates: [], queryTier: 2 };
  }

  const userToken = await tokenFor(1, req.operatorOid);
  const uamiToken = await tokenFor(2);

  if (!userToken && !uamiToken) {
    return {
      ledger: requested.map((id) => ({
        subscriptionId: id,
        displayName: names[id] ?? id,
        status: 'no-access' as const,
        credentialTier: 2 as const,
        matchedResources: 0,
        truncated: false,
        detail: 'Neither your delegated Azure token nor the Console identity could be acquired, so nothing was read.',
      })),
      candidates: [],
      queryTier: 2,
      fatal: {
        code: 'no_credential',
        message:
          'Loom could not acquire an Azure Resource Manager token as you or as the Console identity. Sign in again, or grant the Console managed identity Reader on the subscriptions you want scanned.',
      },
    };
  }

  // ── 1. Establish readability per subscription, operator first ────────────
  const ledger: SubscriptionScanResult[] = [];
  const readable: string[] = [];
  for (const id of requested) {
    let entry: SubscriptionScanResult | null = null;
    if (userToken) {
      const p = await probeSubscription(userToken, id, 8_000);
      if (p.readable) {
        entry = {
          subscriptionId: id,
          displayName: names[id] ?? p.displayName ?? id,
          status: 'scanned',
          credentialTier: 1,
          matchedResources: 0,
          truncated: false,
        };
      }
    }
    if (!entry && uamiToken) {
      const p = await probeSubscription(uamiToken, id, 8_000);
      if (p.readable) {
        entry = {
          subscriptionId: id,
          displayName: names[id] ?? p.displayName ?? id,
          status: 'scanned',
          credentialTier: 2,
          matchedResources: 0,
          truncated: false,
          detail: 'Read as the Loom identity — it may see less than you do.',
        };
      } else {
        entry = {
          subscriptionId: id,
          displayName: names[id] ?? id,
          status: 'no-access',
          credentialTier: 2,
          matchedResources: 0,
          truncated: false,
          detail: p.detail,
        };
      }
    }
    if (!entry) {
      entry = {
        subscriptionId: id,
        displayName: names[id] ?? id,
        status: 'no-access',
        credentialTier: 1,
        matchedResources: 0,
        truncated: false,
        detail: 'Your account could not read this subscription and the Console identity was unavailable to try.',
      };
    }
    ledger.push(entry);
    if (entry.status === 'scanned') readable.push(id);
  }

  if (readable.length === 0) {
    return { ledger, candidates: [], queryTier: userToken ? 1 : 2 };
  }

  // ── 2. One paged ARG query over the readable subscriptions ──────────────
  // Group by the tier that could read them so each query runs under a token
  // that is actually entitled to every scope in it.
  const byTier: Record<1 | 2, string[]> = { 1: [], 2: [] };
  for (const e of ledger) {
    if (e.status === 'scanned') byTier[e.credentialTier === 1 ? 1 : 2].push(e.subscriptionId);
  }

  const query = buildEstateQuery();
  const rows: ArgRow[] = [];
  const truncatedSubs = new Set<string>();
  let queryTier: 1 | 2 = byTier[1].length > 0 ? 1 : 2;
  let graphError: string | null = null;

  for (const tier of [1, 2] as const) {
    const subs = byTier[tier];
    if (subs.length === 0) continue;
    const token = tier === 1 ? userToken : uamiToken;
    if (!token) continue;

    const budget = new PagingBudget(`estate-scan tier ${tier}`, { budgetMs: argBudgetMs(), maxPages: 50 });
    let skipToken: string | undefined;
    let hitDeadline = false;

    while (budget.claimPage()) {
      const options: Record<string, unknown> = {
        resultFormat: 'objectArray',
        // `$top`, not `top` — the previous scan sent `options: {top: 1000}`,
        // which the REST API ignores entirely. It has been a no-op.
        $top: 1000,
        // Never set before: without it a scope above Azure's subscription limit
        // ERRORS instead of returning what it can.
        allowPartialScopes: true,
      };
      if (skipToken) options.$skipToken = skipToken;

      let page: Response | PageDeadline;
      try {
        page = await budget.runPage((timeoutMs) =>
          fetchWithTimeout(
            `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API_VERSION}`,
            {
              method: 'POST',
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify({ subscriptions: subs, query, options }),
              cache: 'no-store',
            },
            timeoutMs,
          ),
        );
      } catch (e: any) {
        graphError = `Azure Resource Graph could not be reached: ${safe(e?.message ?? e, 200)}`;
        break;
      }
      if (page === PAGE_DEADLINE) {
        hitDeadline = true;
        break;
      }
      if (!page.ok) {
        const body = await page.text().catch(() => '');
        graphError = `Azure Resource Graph answered HTTP ${page.status}: ${safe(body, 200)}`;
        break;
      }
      const j: any = await page.json().catch(() => ({}));
      for (const r of (j?.data ?? []) as ArgRow[]) rows.push(r);
      skipToken = typeof j?.$skipToken === 'string' && j.$skipToken ? j.$skipToken : undefined;
      if (!skipToken) break;
    }

    // A `$skipToken` still outstanding, or a wall-clock/page breach, means the
    // walk did NOT see everything for these subscriptions. Recording it here is
    // what stops "no candidates" from being asserted off a partial read.
    if (skipToken || hitDeadline || budget.truncatedBy) {
      for (const s of subs) truncatedSubs.add(s);
    }
    if (tier === 1 && byTier[1].length > 0) queryTier = 1;
  }

  // ── 3. Fold rows into candidates + per-subscription match counts ─────────
  const matched = new Map<string, number>();
  const candidates: AdoptionCandidate[] = [];
  const subName = new Map(ledger.map((e) => [e.subscriptionId, e.displayName]));
  const tierOf = new Map(ledger.map((e) => [e.subscriptionId, e.credentialTier]));

  for (const r of rows) {
    const key = armRowToServiceKey(String(r.type ?? ''), r.kind);
    if (!key) continue;
    const def = getServiceDef(key);
    // A create-only service is scanned so the UI can SAY one exists and explain
    // why Loom still deploys its own — but it is never offered as a candidate.
    if (!def || def.class === 'create-only') continue;
    const sub = String(r.subscriptionId ?? '');
    matched.set(sub, (matched.get(sub) ?? 0) + 1);
    candidates.push({
      serviceKey: key,
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      resourceGroup: String(r.resourceGroup ?? ''),
      subscriptionId: sub,
      subscriptionName: subName.get(sub) ?? sub,
      location: String(r.location ?? ''),
      ...(r.skuName || r.skuTier ? { sku: { name: r.skuName, tier: r.skuTier } } : {}),
      ...(r.kind ? { kind: String(r.kind) } : {}),
      networkPosture: derivePosture(r),
      ...(r.tags && typeof r.tags === 'object' ? { tags: r.tags } : {}),
      credentialTier: (tierOf.get(sub) ?? 2) as 1 | 2 | 3,
    });
  }

  for (const e of ledger) {
    e.matchedResources = matched.get(e.subscriptionId) ?? 0;
    if (truncatedSubs.has(e.subscriptionId)) {
      e.truncated = true;
      e.status = 'partial';
      e.detail =
        'The scan stopped before the last page for this subscription, so anything reported as "not found" here may simply not have been read yet.';
    }
  }

  // A Graph failure AFTER the readability probes succeeded is its own honest
  // state: the subscriptions ARE readable, we just could not enumerate them.
  // It must never render as "nothing adoptable found".
  if (graphError) {
    for (const e of ledger) {
      if (e.status === 'scanned' && (matched.get(e.subscriptionId) ?? 0) === 0) {
        e.status = 'timed-out';
        e.detail = graphError;
      }
    }
    return {
      ledger,
      candidates,
      queryTier,
      fatal: { code: 'graph_unreachable', message: graphError },
    };
  }

  return { ledger, candidates, queryTier };
}
