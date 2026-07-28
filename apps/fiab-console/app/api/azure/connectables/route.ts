/**
 * GET /api/azure/connectables
 * ---------------------------
 * Cross-subscription "Add existing" discovery for /connections. Returns EVERY
 * connectable Azure resource (SQL, PostgreSQL, Storage/ADLS, Cosmos, Synapse,
 * Databricks, Event Hubs, Service Bus, Key Vault) the signed-in user can reach
 * — across ALL subscriptions their RBAC + ABAC grant them — in ONE multi-type
 * Azure Resource Graph query, so they can one-click import any as a Loom
 * Connection.
 *
 *   POST {ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01
 *        body { query: "resources | where type in~ (...) | join (subscription
 *               names) | project ...", options: { resultFormat:'objectArray',
 *               $top, $skipToken } }
 *
 * CREDENTIAL + TRANSPORT LADDER (response tagged `via`):
 *   1. via:'user'     — signed-in user's delegated ARM token via ARG (fast,
 *      single multi-type query; honours the caller's own RBAC + ABAC).
 *   2. via:'uami'      — Loom UAMI ARM token via ARG (Reader-at-root fallback).
 *   3. via:'user-arm'  — user token via the plain ARM control-plane resource
 *      list (FALLBACK). Used when ARG errored or returned zero rows.
 *   4. via:'uami-arm'  — UAMI token via the ARM control-plane resource list.
 *
 * WHY THE ARM-LIST FALLBACK: live testing showed ARG can return a bare-
 * correlationId error (or zero rows) for the UAMI even though it holds Reader
 * at the root MG + subs AND the plain ARM resource list works for the same
 * token. So ARG is the FAST primary path, but when it errors or yields nothing
 * we fall back to the proven control-plane list:
 *   GET {ARM}/subscriptions?api-version=2022-12-01                 → subs
 *   GET {ARM}/subscriptions/{sub}/resources
 *        ?$filter=resourceType eq '<armType>'&api-version=2021-04-01 → rows
 * Both follow `nextLink` paging, bounded by a subscription cap, a per-list
 * page-guard, and an overall wall-clock budget so a large/slow tenant can't
 * hang the gateway. The control-plane list returns no property bag, so hosts
 * are derived by sovereign-cloud naming convention in toConnectable() rather
 * than from ARG endpoint fields.
 *
 * ARG omits `subscriptions` so it spans every subscription the token can read;
 * `$skipToken` paging avoids the 1000-row truncation. The honest gate
 * (code:'no_access', per .claude/rules/no-vaporware.md) is returned ONLY when
 * BOTH ARG and the ARM-list fallback genuinely see nothing on every credential
 * — true no-access. Tokens are never logged or returned to the browser. All
 * hosts use cloud-endpoints suffix helpers so coordinates are correct in every
 * sovereign cloud.
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import {
  armBase, armScope, getSqlSuffix, synapseSqlSuffix,
  cosmosSuffix, serviceBusSuffix, kvSuffix,
} from '@/lib/azure/cloud-endpoints';
import {
  CONNECTABLE_ARM_TYPES, armTypeToConnType, normalizeHost, CONN_TYPE_AUTH_OPTIONS,
  type ConnectableResource,
} from '@/lib/azure/connectable-types';
import { fetchWithTimeout, FetchTimeoutError } from '@/lib/azure/fetch-with-timeout';
import {
  PagingBudget, PAGE_DEADLINE, type PageDeadline, type PagingTruncation,
} from '@/lib/azure/paging-budget';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ARM_SCOPE = armScope();
const ARG_URL = `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`;

// ----- ARM resource-list FALLBACK plumbing --------------------------------
// When Azure Resource Graph (the fast single-query primary path) errors or
// returns nothing for an identity that demonstrably has read access, fall back
// to the plain ARM control-plane resource list, which is proven reliable here:
//   GET {ARM}/subscriptions?api-version=2022-12-01                 → subs
//   GET {ARM}/subscriptions/{sub}/resources
//        ?$filter=resourceType eq '<armType>'&api-version=2021-04-01 → rows
// Both follow `nextLink` paging. The control-plane list does NOT return a
// property bag, so derived hosts come from toConnectable()'s naming-convention
// fallbacks (SQL/Synapse/Storage/Cosmos/EH/SB/KV) instead of ARG endpoint
// fields. Bounded by a subscription cap, a per-list page-guard, and an overall
// wall-clock budget so a slow/large tenant can't hang the gateway.
const SUBS_URL = `${armBase()}/subscriptions?api-version=2022-12-01`;
const ARM_LIST_API_VERSION = '2021-04-01';
const MAX_SUBSCRIPTIONS = 200;
const MAX_PAGES_PER_LIST = 50;
// Wall-clock budget for the ARM control-plane fallback enumeration. A cross-
// subscription sweep (subscriptions list → per-sub, per-type resource list with
// nextLink paging) legitimately takes 20-35s on a large tenant, so this budget
// must be >= the client's per-call ceiling (CONNECTABLES_TIMEOUT_MS = 40s in
// register-existing-source-dialog.tsx). At the old 25s the server aborted the
// fallback mid-enumeration and returned a premature "no access" gate even though
// resources were still being discovered. Kept in step with the client timeout.
//
// #2582: that budget is now a shared {@link PagingBudget} rather than a bespoke
// AbortController, so (a) each page fetch gets the REMAINING wall clock as its
// own `timeoutMs` (the first page is bounded too), (b) a breach TRUNCATES via
// `runPage` instead of throwing, and (c) the truncation is REPORTED — the old
// abort-mid-enumeration path could still fall through to `code:'no_access'`,
// telling the operator to grant Reader for what was actually a deadline.
//
// Both budgets are read PER REQUEST (not once at module load), so retuning them
// for a slow sovereign region takes effect on the next call without a container
// restart — the same posture as LOOM_ARM_PAGING_BUDGET_MS.
function armFallbackBudgetMs(): number {
  const n = Number(process.env.LOOM_CONNECTABLES_ARM_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 40_000;
}
// Total pages the whole cross-sub sweep may fetch. Per-list cycles are already
// stopped by MAX_PAGES_PER_LIST; this is the estate-wide backstop.
const ARM_FALLBACK_MAX_PAGES = 2_000;
// Wall clock for the ARG ($skipToken) fast path. ARG answers a whole estate in
// one or two round-trips, so it gets a much tighter ceiling than the crawl —
// and, before this, no ceiling at all (a bare `fetch`, no timeout).
function argBudgetMs(): number {
  const n = Number(process.env.LOOM_CONNECTABLES_ARG_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/** The honest deadline error surfaced when a walk ran out of wall clock and
 *  collected nothing. Deliberately NOT `code:'no_access'` — a slow ARM must
 *  never be reported as a missing role. */
function pagingTimeoutBody(truncatedBy: PagingTruncation) {
  return {
    ok: false as const,
    code: 'paging_timeout' as const,
    error:
      `Azure resource discovery hit its ${truncatedBy} ceiling before any resource was returned. ` +
      `This is a PAGING DEADLINE — Azure Resource Manager was slow (or the estate is larger than ` +
      `the page cap), NOT a missing permission. Retry; if it persists, check ARM / private-endpoint ` +
      `reachability, then raise ` +
      `${truncatedBy === 'pages'
        ? 'MAX_PAGES_PER_LIST / LOOM_ARM_PAGING_MAX_PAGES'
        : 'LOOM_CONNECTABLES_ARG_BUDGET_MS / LOOM_CONNECTABLES_ARM_BUDGET_MS'}.`,
  };
}

interface ArgRow {
  id: string;
  name: string;
  type: string;
  kind?: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  subName?: string;
  host?: string;
  isHns?: string;
}

function sanitize(s: string): string {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function uamiCredential(): ChainedTokenCredential {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID;
  // MI-FIRST + ACA-FIRST: on Azure Container Apps the stock @azure/identity
  // ManagedIdentityCredential cannot parse the ACA MI token (expires_on is
  // Unix-seconds, expires_in absent) — it yields a token ARG rejects, which
  // surfaced as a misleading "no resources" gate even with Reader granted.
  // AcaManagedIdentityCredential (raw 2019-08-01 + X-IDENTITY-HEADER) must be
  // first, mirroring adls-client.ts and the other data-plane clients.
  return new ChainedTokenCredential(
    new AcaManagedIdentityCredential(),
    new ManagedIdentityCredential(clientId ? { clientId } : {}),
    new DefaultAzureCredential(),
  );
}

/**
 * The single multi-type ARG query. `type in~` is case-insensitive; the
 * leftouter join to ResourceContainers attaches each resource's subscription
 * display name. The coalesced `host` pulls the right endpoint field per type
 * (SQL/PG fqdn, Cosmos documentEndpoint, EH/SB serviceBusEndpoint, KV vaultUri,
 * Synapse serverless SQL, Databricks workspaceUrl, Storage dfs primaryEndpoint).
 */
function buildQuery(): string {
  const types = CONNECTABLE_ARM_TYPES.map((c) => `'${c.armType}'`).join(',');
  return [
    'resources',
    `| where type in~ (${types})`,
    '| extend host = tostring(coalesce(',
    '    properties.fullyQualifiedDomainName,',
    '    properties.documentEndpoint,',
    '    properties.serviceBusEndpoint,',
    '    properties.vaultUri,',
    '    properties.connectivityEndpoints.sqlOnDemand,',
    '    properties.connectivityEndpoints.sql,',
    '    properties.workspaceUrl,',
    '    properties.primaryEndpoints.dfs,',
    "    ''))",
    '| extend isHns = tostring(properties.isHnsEnabled)',
    '| join kind=leftouter (',
    '    ResourceContainers',
    "    | where type =~ 'microsoft.resources/subscriptions'",
    '    | project subscriptionId, subName = name',
    '  ) on subscriptionId',
    '| project id, name, type, kind, location, resourceGroup, subscriptionId, subName, host, isHns',
    '| order by name asc',
  ].join('\n');
}

/**
 * Run the ARG query with a token, following $skipToken paging to completion —
 * BOUNDED by a {@link PagingBudget} (#2582). Previously a bare `fetch` with no
 * deadline at all inside a `do/while`: an unbounded await on a request path.
 */
async function runArg(
  token: string,
): Promise<{ ok: true; rows: ArgRow[]; truncatedBy: PagingTruncation | null } | { ok: false; status: number; error: string }> {
  const query = buildQuery();
  const rows: ArgRow[] = [];
  const budget = new PagingBudget('connectables ARG', { budgetMs: argBudgetMs(), maxPages: 50 });
  let skipToken: string | undefined;
  while (budget.claimPage()) {
    const options: Record<string, unknown> = { resultFormat: 'objectArray', $top: 1000 };
    if (skipToken) options.$skipToken = skipToken;
    let page: Response | PageDeadline;
    try {
      page = await budget.runPage((timeoutMs) => fetchWithTimeout(ARG_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, options }),
      }, timeoutMs));
    } catch (e: any) {
      return { ok: false, status: 502, error: sanitize(e?.message || String(e)) };
    }
    if (page === PAGE_DEADLINE) break; // wall clock spent mid-fetch — keep rows
    const res = page;
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j?.error?.message || j?.error?.code || text; } catch { /* non-JSON */ }
      return { ok: false, status: res.status, error: sanitize(msg) };
    }
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { return { ok: false, status: 502, error: 'Resource Graph returned a non-JSON body' }; }
    if (Array.isArray(body?.data)) rows.push(...body.data);
    skipToken = typeof body?.$skipToken === 'string' ? body.$skipToken : undefined;
    if (!skipToken) break; // finished cleanly — NOT a truncation
  }
  budget.warnIfTruncated(rows.length);
  return { ok: true, rows, truncatedBy: budget.truncatedBy };
}

/** Extract `subscriptionId` and `resourceGroup` out of a full ARM resource id. */
function coordsFromId(id: string): { subscriptionId: string; resourceGroup: string } {
  const sub = /\/subscriptions\/([^/]+)/i.exec(id || '')?.[1] || '';
  const rg = /\/resourcegroups\/([^/]+)/i.exec(id || '')?.[1] || '';
  return { subscriptionId: sub, resourceGroup: rg };
}

/**
 * GET helper with a bearer token and a per-page deadline; returns text + status.
 *
 * A {@link FetchTimeoutError} raised by the deadline the caller's
 * {@link PagingBudget} handed down is RE-THROWN, never folded into the
 * `{ok:false}` descriptor: `runPage` has to see it to absorb it as a
 * truncation. Swallowing it here would make a walk deadline look like a network
 * failure and, downstream, like `code:'no_access'` — telling the operator to
 * grant a role for what was actually a slow ARM.
 */
async function armGet(
  url: string,
  token: string,
  timeoutMs: number,
): Promise<{ ok: true; body: any } | { ok: false; status: number; error: string }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, timeoutMs);
  } catch (e: any) {
    if (e instanceof FetchTimeoutError) throw e;
    return { ok: false, status: 502, error: sanitize(e?.message || String(e)) };
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j?.error?.message || j?.error?.code || text; } catch { /* non-JSON */ }
    return { ok: false, status: res.status, error: sanitize(msg) };
  }
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { return { ok: false, status: 502, error: 'ARM returned a non-JSON body' }; }
  return { ok: true, body };
}

/**
 * List every subscription the token can read, following nextLink paging under
 * the sweep's shared {@link PagingBudget} (page cap + one wall clock across the
 * whole enumeration).
 */
async function listSubscriptions(
  token: string,
  budget: PagingBudget,
): Promise<{ ok: true; subs: { id: string; name?: string }[] } | { ok: false; status: number; error: string }> {
  const subs: { id: string; name?: string }[] = [];
  let url: string = SUBS_URL;
  let pages = 0;
  while (pages++ < MAX_PAGES_PER_LIST && subs.length < MAX_SUBSCRIPTIONS && budget.claimPage()) {
    const r = await budget.runPage((timeoutMs) => armGet(url, token, timeoutMs));
    if (r === PAGE_DEADLINE) break; // wall clock spent mid-fetch — keep subs
    if (!r.ok) return r;
    const arr = Array.isArray(r.body?.value) ? r.body.value : [];
    for (const s of arr) {
      const subId = typeof s?.subscriptionId === 'string' ? s.subscriptionId : '';
      if (subId) subs.push({ id: subId, name: typeof s?.displayName === 'string' ? s.displayName : undefined });
    }
    if (typeof r.body?.nextLink !== 'string' || !r.body.nextLink) break; // finished cleanly
    url = r.body.nextLink;
  }
  return { ok: true, subs: subs.slice(0, MAX_SUBSCRIPTIONS) };
}

/** List one ARM resource type within one subscription, following nextLink. */
async function listResourcesOfType(
  token: string,
  subId: string,
  armType: string,
  subName: string | undefined,
  budget: PagingBudget,
): Promise<ArgRow[]> {
  const rows: ArgRow[] = [];
  const filter = encodeURIComponent(`resourceType eq '${armType}'`);
  let url: string =
    `${armBase()}/subscriptions/${subId}/resources?$filter=${filter}&api-version=${ARM_LIST_API_VERSION}`;
  let pages = 0;
  while (pages++ < MAX_PAGES_PER_LIST && budget.claimPage()) {
    const r = await budget.runPage((timeoutMs) => armGet(url, token, timeoutMs));
    if (r === PAGE_DEADLINE) break; // wall clock spent mid-fetch — keep rows
    if (!r.ok) {
      // A single sub that 403s / 404s shouldn't sink the whole enumeration —
      // skip it and let the other subscriptions contribute their resources.
      break;
    }
    const arr = Array.isArray(r.body?.value) ? r.body.value : [];
    for (const res of arr) {
      const id = typeof res?.id === 'string' ? res.id : '';
      if (!id) continue;
      const { resourceGroup } = coordsFromId(id);
      rows.push({
        id,
        name: typeof res?.name === 'string' ? res.name : '',
        type: typeof res?.type === 'string' ? res.type : armType,
        kind: typeof res?.kind === 'string' ? res.kind : undefined,
        location: typeof res?.location === 'string' ? res.location : undefined,
        resourceGroup,
        subscriptionId: subId,
        subName,
        // No property bag on the control-plane list → host derived downstream.
        host: '',
      });
    }
    if (typeof r.body?.nextLink !== 'string' || !r.body.nextLink) break; // finished cleanly
    url = r.body.nextLink;
  }
  return rows;
}

/**
 * ARM control-plane resource-list fallback. Enumerates every connectable ARM
 * type across every subscription the token can read, mapping the bare control-
 * plane rows into the same ArgRow shape the ARG path produces. Returns rows on
 * success (possibly empty) or an error descriptor if even the subscriptions
 * list is unreachable (true no-access).
 *
 * ONE {@link PagingBudget} spans the whole sweep, so the 40s wall clock is
 * shared across the subscriptions list and every per-sub/per-type list, and each
 * page fetch is bounded by whatever is LEFT of it. `truncatedBy` is returned so
 * the caller can tell "we saw nothing" apart from "we ran out of time before we
 * could see anything" — the latter must never render as the grant-Reader gate.
 */
async function runArmList(
  token: string,
): Promise<{ ok: true; rows: ArgRow[]; truncatedBy: PagingTruncation | null } | { ok: false; status: number; error: string }> {
  const budget = new PagingBudget('connectables ARM control-plane list', {
    budgetMs: armFallbackBudgetMs(),
    maxPages: ARM_FALLBACK_MAX_PAGES,
  });
  try {
    const subsResult = await listSubscriptions(token, budget);
    if (!subsResult.ok) return subsResult;
    const rows: ArgRow[] = [];
    for (const sub of subsResult.subs) {
      if (budget.truncatedBy) break;
      for (const c of CONNECTABLE_ARM_TYPES) {
        if (budget.truncatedBy) break;
        const typeRows = await listResourcesOfType(token, sub.id, c.armType, sub.name, budget);
        rows.push(...typeRows);
      }
    }
    rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    budget.warnIfTruncated(rows.length);
    return { ok: true, rows, truncatedBy: budget.truncatedBy };
  } catch (e: any) {
    return { ok: false, status: 502, error: sanitize(e?.message || String(e)) };
  }
}

/** Last `/databases/<db>` segment's parent server name, for SQL DB hosts. */
function sqlServerFromId(id: string): string | null {
  const m = /\/servers\/([^/]+)\/databases\//i.exec(id || '');
  return m ? m[1] : null;
}

/**
 * Map one ARG row to a ConnectableResource, deriving the bare host per type
 * using sovereign-cloud suffix helpers where the ARG endpoint field is absent
 * (SQL databases carry no FQDN — it is derived from the parent server name).
 */
function toConnectable(row: ArgRow): ConnectableResource | null {
  const connType = armTypeToConnType(row.type);
  if (!connType) return null;
  let host = normalizeHost(row.host);
  let database: string | undefined;

  switch (connType) {
    case 'azure-sql': {
      const server = sqlServerFromId(row.id);
      if (server) host = `${server}.${getSqlSuffix()}`;
      database = row.name;
      break;
    }
    case 'synapse-serverless':
      // Prefer the serverless (on-demand) endpoint already coalesced into host;
      // fall back to the conventional `<workspace>-ondemand` FQDN.
      if (!host) host = `${row.name}-ondemand.${synapseSqlSuffix()}`;
      break;
    case 'storage-adls':
      // Storage connections key off the bare account name (the builder's
      // "Account / host" field), not the full dfs URL.
      host = row.name;
      break;
    case 'cosmos':
      // ARM resource-list carries no property bag (no documentEndpoint), so
      // derive the canonical account FQDN by naming convention when absent.
      if (!host) host = `${row.name}.${cosmosSuffix()}`;
      break;
    case 'event-hub':
    case 'service-bus':
      // EH and SB namespaces share the servicebus.* suffix; derive the
      // namespace FQDN when the ARG serviceBusEndpoint wasn't available.
      if (!host) host = `${row.name}.${serviceBusSuffix()}`;
      break;
    case 'key-vault':
      if (!host) host = `${row.name}.${kvSuffix()}`;
      break;
    default:
      break;
  }

  // Pick the first (most preferred) auth method for this connection type.
  const suggestedAuth = (CONN_TYPE_AUTH_OPTIONS[connType]?.[0]) ?? 'entra-mi';

  return {
    armResourceId: row.id,
    name: row.name,
    armType: row.type,
    connType,
    host,
    database,
    subscriptionId: row.subscriptionId || '',
    subscriptionName: row.subName || undefined,
    resourceGroup: row.resourceGroup || '',
    location: row.location || undefined,
    suggestedAuth,
  };
}

const GATE_MESSAGE =
  'No connectable Azure resources were returned across the subscriptions visible to Loom. ' +
  'This usually means one of two one-time admin actions is still pending: ' +
  '(1) Admin-consent the Loom app registration for the Azure Service Management ' +
  'delegated permission "user_impersonation" (' + armBase() + '/user_impersonation) ' +
  'so "Add existing" can query with each user\'s own RBAC + ABAC; and/or ' +
  '(2) Grant the Loom user-assigned managed identity (LOOM_UAMI_CLIENT_ID) the ' +
  '"Reader" role at the tenant root management group so the UAMI fallback can ' +
  'enumerate resources. Once either is in place, resources you can access appear here.';

export const GET = withSession(async (_req, { session }) => {
  type Via = 'user' | 'uami' | 'user-arm' | 'uami-arm';
  const finalize = (rows: ArgRow[], via: Via, truncatedBy: PagingTruncation | null = null) => {
    const resources = rows
      .map(toConnectable)
      .filter((r): r is ConnectableResource => r !== null);
    // `truncated` is additive and only set on a short walk — a picker that found
    // what it wanted in a truncated list has a perfectly good answer, but a
    // caller that cares can tell the list is not the whole estate.
    return NextResponse.json({ ok: true, resources, via, truncated: truncatedBy ?? undefined });
  };

  // Any walk that ran out of wall clock / pages WITHOUT collecting a row. Kept
  // separate from the no-access gate so a slow ARM is never reported as a
  // missing role (the failure mode the old 25s abort produced verbatim).
  let deadlineTruncation: PagingTruncation | null = null;

  // Tokens captured on the ARG pass so the ARM-list fallback can reuse them
  // without re-acquiring (the user token is per-user RBAC; the UAMI token is
  // the Reader-at-root fallback).
  let userToken: string | null = null;
  let uamiToken: string | null = null;

  // ---- (a) User delegated ARM token (per-user RBAC + ABAC) — ARG fast path
  let userArgError: { status: number; error: string } | null = null;
  try {
    userToken = (await getUserArmToken(session.claims.oid)) || null;
    if (userToken) {
      const r = await runArg(userToken);
      // Return immediately only when ARG succeeded AND saw rows; an empty ARG
      // result with a healthy token falls through to the ARM-list fallback,
      // which is proven to enumerate where ARG silently returns nothing.
      if (r.ok && r.rows.length > 0) return finalize(r.rows, 'user', r.truncatedBy);
      if (r.ok && r.truncatedBy) deadlineTruncation ??= r.truncatedBy;
      if (!r.ok) userArgError = { status: r.status, error: r.error };
    }
  } catch {
    // fall through to UAMI
  }

  // ---- (b) UAMI — ARG fast path -----------------------------------------
  let uamiArgError: { status: number; error: string } | null = null;
  try {
    const tok = await uamiCredential().getToken(ARM_SCOPE);
    uamiToken = tok?.token || null;
    if (uamiToken) {
      const r = await runArg(uamiToken);
      if (r.ok && r.rows.length > 0) return finalize(r.rows, 'uami', r.truncatedBy);
      if (r.ok && r.truncatedBy) deadlineTruncation ??= r.truncatedBy;
      if (!r.ok) uamiArgError = { status: r.status, error: r.error };
    }
  } catch (e: any) {
    uamiArgError = { status: 502, error: sanitize(e?.message || String(e)) };
  }

  // ---- (c) ARM control-plane resource-list FALLBACK ----------------------
  // ARG either errored or returned zero rows on every credential available.
  // Try the proven ARM resource-list with the same tokens: user first (per-
  // user RBAC), then UAMI (Reader at root). First path that yields rows wins.
  if (userToken) {
    const r = await runArmList(userToken);
    if (r.ok && r.rows.length > 0) return finalize(r.rows, 'user-arm', r.truncatedBy);
    if (r.ok && r.truncatedBy) deadlineTruncation ??= r.truncatedBy;
  }
  if (uamiToken) {
    const r = await runArmList(uamiToken);
    if (r.ok && r.rows.length > 0) return finalize(r.rows, 'uami-arm', r.truncatedBy);
    if (r.ok && r.truncatedBy) deadlineTruncation ??= r.truncatedBy;
  }

  // ---- (d) A DEADLINE, not a permission problem --------------------------
  // Every path came back empty, but at least one of them stopped early because
  // it ran out of wall clock / pages. "Not found in a truncated list" is not an
  // answer (see docs/fiab/arm-paging-budget.md), so say deadline — the
  // no_access gate below would tell the operator to grant Reader for what is
  // actually a slow ARM.
  if (deadlineTruncation) {
    return NextResponse.json(pagingTimeoutBody(deadlineTruncation), { status: 200 });
  }

  // ---- (e) Honest gate — BOTH ARG and the ARM-list fallback saw nothing ---
  const detail =
    uamiArgError ? ` (Resource Graph error via UAMI: ${uamiArgError.error})`
    : userArgError ? ` (Resource Graph error via user token: ${userArgError.error})`
    : '';
  return NextResponse.json(
    { ok: false, code: 'no_access', error: `${GATE_MESSAGE}${detail}` },
    { status: 200 },
  );
});
