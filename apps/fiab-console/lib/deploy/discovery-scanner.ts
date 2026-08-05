/**
 * discovery-scanner — the multi-subscription adoption scan (deploy-integrity R5.1).
 *
 * Answers ONE question honestly: across the subscriptions the operator allowed
 * us to look at, what already exists that CSA Loom could adopt — and, just as
 * importantly, which of those subscriptions we could NOT read.
 *
 * ## The shape of the scan, and why it is three queries rather than one
 *
 * The obvious implementation is a single scoped Resource Graph query and a
 * ledger derived from its rows. That implementation is wrong, and it is the
 * exact defect this module exists to avoid.
 *
 * Measured live on 2026-08-05 (see the contract notes in `discovery-model.ts`):
 * **ARG silently drops a subscription the caller cannot read.** Pass a readable
 * and an unreadable subscription together and you get HTTP 200, rows for the
 * readable one, and no signal at all about the other. `allowPartialScopes`
 * does not change this. So "0 rows from subscription X" and "we never read
 * subscription X" are indistinguishable in the inventory response — and
 * reporting the second as the first is the `unknown reported as negative`
 * class: the operator is told their estate has nothing to adopt when the truth
 * is that Loom could not look.
 *
 * Therefore:
 *
 *   1. **ARM `GET /subscriptions`** establishes what this identity can see at
 *      all. A requested subscription absent from that list is `no-access`, and
 *      we can say exactly how we know.
 *   2. **The ARG coverage probe** (`ResourceContainers | where type =~
 *      'microsoft.resources/subscriptions'`) establishes which of those ARG
 *      itself will actually read. It returns a row per readable subscription
 *      *including empty ones*, which is what makes a genuinely empty greenfield
 *      subscription distinguishable from an unreadable one. A requested,
 *      ARM-visible subscription missing from this probe is `no-access` — again
 *      with the observation recorded.
 *   3. **The inventory query**, scoped to exactly the subscriptions step 2
 *      proved readable, so it can no longer drop anything silently.
 *
 * Only then is the ledger built — from the REQUESTED list, never from the
 * result rows.
 *
 * ## Credential ladder
 *
 * Tier 1 is the signed-in operator's delegated ARM token, tier 2 the Console
 * UAMI. That order is deliberate and is the reverse of what the pre-deploy scan
 * routes do today: at first run the operator is typically Owner across the
 * estate while the Console UAMI may not exist yet, let alone hold Reader. The
 * tier that answered is reported per subscription so a narrower result can be
 * explained rather than mistaken for an empty estate.
 *
 * No mock arrays anywhere (`.claude/rules/no-vaporware.md`): the transport is
 * injectable purely so tests can replay REAL captured ARG responses, and the
 * default transport is a real bounded `fetch`.
 */

import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import { fetchWithTimeout, FetchTimeoutError } from '@/lib/azure/fetch-with-timeout';
import { PagingBudget, PAGE_DEADLINE, type PagingTruncation } from '@/lib/azure/paging-budget';
import {
  COVERAGE_QUERY,
  buildInventoryQuery,
  buildServiceDiscoveries,
  rowToCandidate,
  summariseCoverage,
  type AdoptionCandidate,
  type CredentialTier,
  type DiscoveryResult,
  type InventoryRow,
  type SubscriptionScanResult,
} from './discovery-model';

const ARG_API_VERSION = '2022-10-01';
const SUBSCRIPTIONS_API_VERSION = '2022-12-01';
/** ARM refuses very large scope arrays; also keeps one request sane. */
const MAX_SCOPED_SUBSCRIPTIONS = 500;

/** Wall clock for the whole scan's ARG paging. */
function argBudgetMs(): number {
  const n = Number(process.env.LOOM_DISCOVERY_ARG_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 25_000;
}
/** Wall clock for the ARM subscriptions enumeration. */
function subsBudgetMs(): number {
  const n = Number(process.env.LOOM_DISCOVERY_SUBS_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

/** Strip markup and clamp, so an upstream message can never be a payload. */
function sanitize(s: string): string {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

// ---------------------------------------------------------------------------
// Transport (injectable ONLY so tests can replay real captured responses)
// ---------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  /** Parsed JSON body, or null when the body was absent / unparseable. */
  body: unknown;
  /** Set when the response was not JSON or the request failed outright. */
  error?: string;
}

export interface DiscoveryTransport {
  /** POST the ARG endpoint. */
  argQuery(token: string, payload: unknown, timeoutMs: number): Promise<HttpResult>;
  /** GET an ARM url (subscriptions list / nextLink). */
  armGet(token: string, url: string, timeoutMs: number): Promise<HttpResult>;
}

async function readJson(res: Response): Promise<HttpResult> {
  const text = await res.text();
  if (!text) return { status: res.status, body: null };
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: null, error: sanitize(text) };
  }
}

/** The real, bounded transport. */
export const liveTransport: DiscoveryTransport = {
  async argQuery(token, payload, timeoutMs) {
    const url = `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API_VERSION}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      },
      timeoutMs,
    );
    return readJson(res);
  },
  async armGet(token, url, timeoutMs) {
    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { authorization: `Bearer ${token}` }, cache: 'no-store' },
      timeoutMs,
    );
    return readJson(res);
  },
};

/** Pull the most specific error string ARM/ARG offered, for an honest message. */
export function armErrorMessage(r: HttpResult): string {
  const b = r.body as any;
  const detail = b?.error?.details?.[0];
  const msg = detail?.message || detail?.code || b?.error?.message || b?.error?.code || r.error;
  return sanitize(String(msg ?? `HTTP ${r.status}`));
}

// ---------------------------------------------------------------------------
// Credential acquisition
// ---------------------------------------------------------------------------

export interface DiscoveryCredentials {
  /** Signed-in operator's delegated ARM token, when one is cached. */
  userToken: string | null;
  /** Console UAMI ARM token, when obtainable. */
  uamiToken: string | null;
  /** Why the UAMI token could not be acquired, when it could not. */
  uamiError?: string;
}

export async function acquireCredentials(oid: string | undefined): Promise<DiscoveryCredentials> {
  let userToken: string | null = null;
  if (oid) {
    try {
      userToken = (await getUserArmToken(oid)) || null;
    } catch {
      userToken = null;
    }
  }
  let uamiToken: string | null = null;
  let uamiError: string | undefined;
  try {
    const t = await uamiArmCredential().getToken(armScope());
    uamiToken = t?.token || null;
    if (!uamiToken) uamiError = 'the managed identity returned an empty token';
  } catch (e: any) {
    uamiError = sanitize(e?.message || String(e));
  }
  return { userToken, uamiToken, uamiError };
}

// ---------------------------------------------------------------------------
// Step 1 — what subscriptions can this identity see at all?
// ---------------------------------------------------------------------------

export interface VisibleSubscription {
  subscriptionId: string;
  displayName: string;
}

export type SubsListOutcome =
  | { ok: true; subscriptions: VisibleSubscription[]; truncatedBy: PagingTruncation | null }
  | { ok: false; error: string; status: number };

export async function listVisibleSubscriptions(
  transport: DiscoveryTransport,
  token: string,
): Promise<SubsListOutcome> {
  const budget = new PagingBudget('discovery subscriptions list', {
    budgetMs: subsBudgetMs(),
    maxPages: 50,
  });
  const out: VisibleSubscription[] = [];
  let url: string | null = `${armBase()}/subscriptions?api-version=${SUBSCRIPTIONS_API_VERSION}`;
  let firstPage = true;
  while (url && budget.claimPage()) {
    const nextUrl: string = url;
    let r: HttpResult | typeof PAGE_DEADLINE;
    try {
      r = await budget.runPage((timeoutMs) => transport.armGet(token, nextUrl, timeoutMs));
    } catch (e: any) {
      if (e instanceof FetchTimeoutError) break;
      return { ok: false, error: sanitize(e?.message || String(e)), status: 0 };
    }
    if (r === PAGE_DEADLINE) break;
    if (r.status < 200 || r.status >= 300) {
      // A failure on the FIRST page means we established nothing; a failure on a
      // later page means we have a partial list. Only the first is fatal.
      if (firstPage) return { ok: false, error: armErrorMessage(r), status: r.status };
      break;
    }
    firstPage = false;
    const body = r.body as any;
    for (const s of Array.isArray(body?.value) ? body.value : []) {
      const id = typeof s?.subscriptionId === 'string' ? s.subscriptionId : '';
      if (!id) continue;
      // Disabled / warned subscriptions cannot host resources and ARG rejects
      // them as ineligible scopes, so they are not offered as scan targets.
      const state = String(s?.state ?? '').toLowerCase();
      if (state && state !== 'enabled' && state !== 'warned') continue;
      out.push({ subscriptionId: id, displayName: String(s?.displayName ?? '') });
    }
    url = typeof body?.nextLink === 'string' && body.nextLink ? body.nextLink : null;
  }
  return { ok: true, subscriptions: out, truncatedBy: budget.truncatedBy };
}

// ---------------------------------------------------------------------------
// Step 2 — which of those will ARG actually read?
// ---------------------------------------------------------------------------

export type CoverageOutcome =
  | { ok: true; readable: Map<string, string> }
  | { ok: false; error: string; status: number };

/**
 * Run the coverage probe over an explicit scope. Returns subscriptionId →
 * display name for exactly the subscriptions ARG proved it can read.
 *
 * Never called with an empty scope: ARG rejects a scoped query whose every
 * scope is ineligible with `NoValidSubscriptionsInQueryRequest`, and a caller
 * that treated that 400 as "nothing found" would be manufacturing the very
 * false negative this module exists to prevent.
 */
export async function probeCoverage(
  transport: DiscoveryTransport,
  token: string,
  subscriptionIds: string[],
): Promise<CoverageOutcome> {
  if (subscriptionIds.length === 0) {
    return { ok: false, error: 'no eligible subscription scopes to probe', status: 0 };
  }
  const r = await transport.argQuery(
    token,
    {
      subscriptions: subscriptionIds.slice(0, MAX_SCOPED_SUBSCRIPTIONS),
      query: COVERAGE_QUERY,
      options: { resultFormat: 'objectArray', $top: 1000, allowPartialScopes: true },
    },
    argBudgetMs(),
  );
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, error: armErrorMessage(r), status: r.status };
  }
  const rows = Array.isArray((r.body as any)?.data) ? ((r.body as any).data as any[]) : [];
  const readable = new Map<string, string>();
  for (const row of rows) {
    const id = typeof row?.subscriptionId === 'string' ? row.subscriptionId : '';
    if (id) readable.set(id, String(row?.subName ?? ''));
  }
  return { ok: true, readable };
}

// ---------------------------------------------------------------------------
// Step 3 — the inventory
// ---------------------------------------------------------------------------

export type InventoryOutcome =
  | { ok: true; rows: InventoryRow[]; truncatedBy: PagingTruncation | null }
  | { ok: false; error: string; status: number };

export async function runInventory(
  transport: DiscoveryTransport,
  token: string,
  subscriptionIds: string[],
): Promise<InventoryOutcome> {
  const query = buildInventoryQuery();
  const budget = new PagingBudget('discovery inventory', { budgetMs: argBudgetMs(), maxPages: 60 });
  const rows: InventoryRow[] = [];
  let skipToken: string | undefined;
  while (budget.claimPage()) {
    const options: Record<string, unknown> = {
      resultFormat: 'objectArray',
      // $top — NOT `top`. Measured: `options:{top:5}` returns 1000 rows because
      // the key is ignored entirely. The wrong key has been shipped elsewhere.
      $top: 1000,
      allowPartialScopes: true,
    };
    if (skipToken) options.$skipToken = skipToken;
    let r: HttpResult | typeof PAGE_DEADLINE;
    try {
      r = await budget.runPage((timeoutMs) =>
        transport.argQuery(
          token,
          { subscriptions: subscriptionIds.slice(0, MAX_SCOPED_SUBSCRIPTIONS), query, options },
          timeoutMs,
        ),
      );
    } catch (e: any) {
      if (e instanceof FetchTimeoutError) break;
      return { ok: false, error: sanitize(e?.message || String(e)), status: 0 };
    }
    if (r === PAGE_DEADLINE) break; // wall clock spent mid-page — keep what we have
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, error: armErrorMessage(r), status: r.status };
    }
    const body = r.body as any;
    if (Array.isArray(body?.data)) rows.push(...(body.data as InventoryRow[]));
    // `$skipToken` is the ONLY truncation signal — `resultTruncated` stays
    // "false" on a response that carries one (measured).
    skipToken = typeof body?.$skipToken === 'string' ? body.$skipToken : undefined;
    if (!skipToken) return { ok: true, rows, truncatedBy: budget.truncatedBy };
  }
  budget.warnIfTruncated(rows.length);
  // Falling out of the loop means the budget stopped us with a $skipToken still
  // outstanding — genuinely incomplete, and reported as such.
  return { ok: true, rows, truncatedBy: budget.truncatedBy ?? 'pages' };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export interface ScanRequest {
  /**
   * Subscriptions to scan. When omitted, every subscription the identity can
   * enumerate is scanned — consent is confirm-and-proceed, not opt-in from
   * empty, because an unchecked-by-default list produces a false "nothing found".
   */
  subscriptions?: string[];
  /** Region the hub will deploy into, used by the recommendation engine. */
  hubRegion?: string;
}

export type ScanOutcome =
  | { ok: true; result: DiscoveryResult }
  | {
      ok: false;
      /**
       * `no_access` — every credential failed to enumerate anything.
       * `arg_error` — Resource Graph itself refused the query.
       * `no_identity` — no usable ARM credential at all.
       */
      code: 'no_access' | 'arg_error' | 'no_identity';
      error: string;
      /** What the code observed, so the message asserts nothing it did not see. */
      established: string;
    };

interface TierAttempt {
  tier: CredentialTier;
  token: string;
}

/**
 * Run the full scan. Pure orchestration over the three steps above; every
 * status in the returned ledger is backed by an `established` observation.
 */
export async function scanForAdoptionCandidates(
  req: ScanRequest,
  creds: DiscoveryCredentials,
  transport: DiscoveryTransport = liveTransport,
): Promise<ScanOutcome> {
  const attempts: TierAttempt[] = [];
  if (creds.userToken) attempts.push({ tier: 'user', token: creds.userToken });
  if (creds.uamiToken) attempts.push({ tier: 'uami', token: creds.uamiToken });
  if (attempts.length === 0) {
    return {
      ok: false,
      code: 'no_identity',
      error:
        'Loom has no Azure credential to scan with. Sign in again so your delegated Azure ' +
        'Resource Manager token is available, or confirm the Console managed identity is configured.',
      established: creds.uamiError
        ? `no cached user ARM token, and the managed identity token request failed: ${creds.uamiError}`
        : 'no cached user ARM token and no managed identity token',
    };
  }

  const requested = Array.from(new Set((req.subscriptions ?? []).filter(Boolean)));
  const failures: string[] = [];

  for (const attempt of attempts) {
    // --- step 1: what can this identity see? ---
    const subsOutcome = await listVisibleSubscriptions(transport, attempt.token);
    if (!subsOutcome.ok) {
      failures.push(`${attempt.tier}: could not list subscriptions (${subsOutcome.error})`);
      continue;
    }
    const visible = new Map(subsOutcome.subscriptions.map((s) => [s.subscriptionId, s.displayName]));
    if (visible.size === 0) {
      failures.push(`${attempt.tier}: ARM returned zero subscriptions for this identity`);
      continue;
    }

    // The scan set: what the operator asked for, or everything visible.
    const scanSet = requested.length > 0 ? requested : Array.from(visible.keys());
    const eligible = scanSet.filter((s) => visible.has(s));

    // Requested but not even visible in ARM — established, not guessed.
    const ledger: SubscriptionScanResult[] = [];
    for (const id of scanSet) {
      if (!visible.has(id)) {
        ledger.push({
          subscriptionId: id,
          displayName: '',
          status: 'no-access',
          credentialTier: attempt.tier,
          matchedResources: 0,
          established:
            `ARM GET /subscriptions did not return this subscription for the ` +
            `${attempt.tier === 'user' ? 'signed-in operator' : 'Console managed identity'}`,
        });
      }
    }

    if (eligible.length === 0) {
      // Nothing to query. Do NOT call ARG — it would 400 with
      // NoValidSubscriptionsInQueryRequest and a caller could mistake that for
      // an empty estate. Try the next credential instead.
      failures.push(
        `${attempt.tier}: none of the ${scanSet.length} requested subscription(s) are visible to this identity`,
      );
      continue;
    }

    // --- step 2: which of those will ARG actually read? ---
    const coverage = await probeCoverage(transport, attempt.token, eligible);
    if (!coverage.ok) {
      failures.push(`${attempt.tier}: Resource Graph coverage probe failed (${coverage.error})`);
      continue;
    }

    for (const id of eligible) {
      if (!coverage.readable.has(id)) {
        ledger.push({
          subscriptionId: id,
          displayName: visible.get(id) ?? '',
          status: 'no-access',
          credentialTier: attempt.tier,
          matchedResources: 0,
          established:
            'ARM lists this subscription, but Azure Resource Graph did not return its container ' +
            'row when explicitly scoped to it — Resource Graph cannot read it with this identity',
        });
      }
    }

    const readableIds = eligible.filter((id) => coverage.readable.has(id));
    if (readableIds.length === 0) {
      failures.push(`${attempt.tier}: Resource Graph could read none of the requested subscriptions`);
      continue;
    }

    // --- step 3: the inventory, scoped to proven-readable scopes only ---
    const inventory = await runInventory(transport, attempt.token, readableIds);
    if (!inventory.ok) {
      failures.push(`${attempt.tier}: Resource Graph inventory query failed (${inventory.error})`);
      continue;
    }

    const discoveredAt = new Date().toISOString();
    const candidates: AdoptionCandidate[] = [];
    const matchesBySub = new Map<string, number>();
    for (const row of inventory.rows) {
      const c = rowToCandidate(row, attempt.tier, discoveredAt);
      if (!c) continue; // ARM type present in the query but not an adoption target
      candidates.push(c);
      matchesBySub.set(c.subscriptionId, (matchesBySub.get(c.subscriptionId) ?? 0) + 1);
    }

    // A budget breach means SOME subscription's inventory is short and we cannot
    // attribute which — so every scanned subscription is reported `truncated`
    // rather than one of them being silently credited with a complete read.
    const truncated = inventory.truncatedBy !== null;
    for (const id of readableIds) {
      ledger.push({
        subscriptionId: id,
        displayName: coverage.readable.get(id) || visible.get(id) || '',
        status: truncated ? 'truncated' : 'scanned',
        credentialTier: attempt.tier,
        matchedResources: matchesBySub.get(id) ?? 0,
        established: truncated
          ? `Resource Graph read this subscription but the scan hit its ${inventory.truncatedBy} ` +
            `ceiling before the inventory was exhausted`
          : 'Resource Graph returned this subscription and its full inventory page set',
      });
    }

    // Preserve the operator's ordering so the UI list is stable.
    const order = new Map(scanSet.map((id, i) => [id, i]));
    ledger.sort((a, b) => (order.get(a.subscriptionId) ?? 0) - (order.get(b.subscriptionId) ?? 0));

    return {
      ok: true,
      result: {
        subscriptions: ledger,
        services: buildServiceDiscoveries(candidates, ledger, { hubRegion: req.hubRegion }),
        credentialTier: attempt.tier,
        truncatedBy: inventory.truncatedBy,
        scannedAt: discoveredAt,
        summary: summariseCoverage(ledger),
      },
    };
  }

  // Every credential failed. Report WHY, per tier — never "nothing found".
  const established = failures.join('; ');
  const argRefused = failures.some((f) => f.includes('Resource Graph'));
  return {
    ok: false,
    code: argRefused ? 'arg_error' : 'no_access',
    error:
      'Loom could not read any of the subscriptions requested for this scan. This is NOT a ' +
      'statement that your estate is empty — it means the scan could not look. Grant the ' +
      'signed-in operator (or the Console managed identity) the Reader role on the subscriptions ' +
      'you want scanned, then run the scan again.',
    established,
  };
}
