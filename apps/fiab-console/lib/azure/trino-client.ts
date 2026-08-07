/**
 * N7e — Trino **Federated SQL** engine client. SERVER-ONLY (imports the Cosmos
 * audit trail + the Entra credential chain).
 *
 * ## The tier (DEFAULT-ON, opt-out)
 *
 * Trino OSS (Apache-2.0) runs as a **single-node, scale-to-zero, INTERNAL-ingress
 * Azure Container App** in the deployment's own VNet
 * (`platform/fiab/bicep/modules/data-plane/loom-trino-aca.bicep`), deployed by
 * every push-button install in both clouds. It can register against N1's
 * **Iceberg REST Catalog** (`LOOM_ICEBERG_CATALOG_URL`) plus any external
 * connectors (PostgreSQL, MySQL, Kafka, MongoDB, …) supplied through
 * `loomBackends.trinoCatalogs` / `trinoCatalogSecrets`. It is an ADDITIVE
 * engine: one SQL statement can JOIN a Loom Iceberg table with an external
 * Postgres table, which the light default (DuckDB N2b) does not do.
 *
 * ## Why it is no longer the opt-in carve-out (PR #2641)
 *
 * Trino used to be the ONE documented opt-in exception to
 * `loom_default_on_opt_out`, on the grounds that it needed an always-on private
 * AKS node pool. That premise no longer holds. Trino's supported single-process
 * shape (`coordinator=true` + `node-scheduler.include-coordinator=true`) runs
 * the whole engine in one container, so it deploys with `minReplicas: 0` and
 * bills NOTHING at idle — Container Apps activates a replica on the first BFF
 * request. The multi-node AKS module (`loom-trino-aks.bicep`) survives as the
 * OPT-IN scale-out upgrade for large federations. Opt out of the default with
 * `loomBackends.trino='disabled'`; SQL Lab stays fully functional on DuckDB /
 * Synapse Serverless and the Trino engine option honest-gates.
 *
 * ## Honest limits on a fresh deploy
 *
 * The orchestrator passes `icebergCatalogUrl: ''` because the N1 Iceberg REST
 * Catalog is still an out-of-band deploy (`svc-iceberg-catalog`, a separate
 * gate). Rather than wire a URL that does not answer, the entrypoint renders NO
 * lake catalog at all — so on a from-scratch install `SHOW CATALOGS` returns
 * `jmx` + `memory` and nothing else. The engine is real and reachable; the LAKE
 * federation appears on the next revision once `LOOM_ICEBERG_CATALOG_URL` is
 * real. That is stated plainly rather than implied away.
 *
 * ## Not public — and, since round 3, not anonymous either
 *
 * The coordinator has INTERNAL ingress only, but internal ingress is a NETWORK
 * control, not an authorization one: it means "reachable by everything already
 * on the VNet". Round 1 of #2641 shipped the engine with no
 * `http-server.authentication.type`, so a sibling container, a peered host or an
 * admin on the P2S VPN could POST `/v1/statement` with an arbitrary
 * `X-Trino-User` and bypass both the session check here AND the audit row below.
 *
 * Round 3 closes that. `apps/loom-trino/docker-entrypoint.sh` enables Trino's
 * **JWT authenticator** by default against the ACTIVE cloud's Entra JWKS with
 * the accepted audience PINNED, and `loom-trino-aca.bicep` deploys it that way
 * (`authMode: 'entra'`). Three states, reported to this client as
 * `LOOM_TRINO_AUTH_MODE`:
 *
 *   * **entra** — audience pinned to the Console's app registration. This BFF
 *     mints a UAMI bearer for `LOOM_TRINO_AUDIENCE` ({@link trinoAuthHeader})
 *     and queries run. Everything else on the VNet gets 401.
 *   * **sealed** — a from-scratch deploy has no app registration to pin (ARM
 *     cannot create a Graph object), so the audience is the sentinel
 *     `api://loom-trino-sealed.invalid` that no tenant can mint. The engine is
 *     up, `minReplicas: 0` so it bills nothing, and serves NOBODY. This client
 *     refuses to fire a query that is guaranteed to 401 and returns an honest
 *     gate instead. Running the sign-in bootstrap
 *     (`csa-loom-post-deploy-bootstrap.yml`) + redeploy un-seals it.
 *   * **disabled** — the explicit, audited opt-out
 *     (`loomBackends.trinoAuthMode='disabled'`), i.e. the anonymous VNet-only
 *     posture. The container logs a SECURITY WARNING on every boot and the
 *     Console env-check reports it as failing.
 *
 * A pre-shared bearer (`LOOM_TRINO_TOKEN`, Key Vault secretRef) still takes
 * precedence for a BYO cluster configured with its own token auth.
 *
 * ## Audited data plane (ATO)
 *
 * A federated query issued THROUGH THIS CLIENT is an external data-access event,
 * so {@link logTrinoAccess} writes an `_auditLog` row (principal, statement
 * scope, catalogs, rows, outcome, ts) and fans out through `emitAuditEvent`. The
 * audit write is awaited before the response is sent. Note the scope: this
 * covers the BFF path, not a direct in-VNet caller (see above).
 *
 * IL5 / SOVEREIGN MOAT: Trino is a self-hosted OSS container on the deployment's
 * own Container Apps environment inside the VNet, reading the deployment's own
 * ADLS Gen2 (via the N1 Iceberg catalog) and in-boundary external sources. There
 * is NO SaaS query federation (no Starburst Galaxy, no Athena) in the path, so
 * the whole capability runs disconnected in an air-gapped enclave. No Microsoft
 * Fabric / OneLake / Power BI is reachable from any path here
 * (.claude/rules/no-fabric-dependency.md).
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { quoteIdent } from '@/lib/sql/quoting';

/** Registry gate id — mirrors the ENV_CHECKS spec in env-checks/data-plane.ts. */
export const TRINO_GATE_ID = 'svc-loom-trino';

/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const TRINO_FLAG_ID = 'n7e-trino-federation';

/** Honest config gate — the missing env var, or null when the cluster is wired. */
export function trinoConfigGate(): { missing: string } | null {
  return (process.env.LOOM_TRINO_URL || '').trim() ? null : { missing: 'LOOM_TRINO_URL' };
}

/** True when the opt-in Trino federation cluster is deployed + wired. */
export function isTrinoConfigured(): boolean {
  return trinoConfigGate() === null;
}

/**
 * The DEPLOYED authorization posture of the engine, as reported by the module
 * that deployed it (`LOOM_TRINO_AUTH_MODE`, emitted by admin-plane/main.bicep):
 *
 *   `entra`    — Trino's JWT authenticator is enforcing and the audience is
 *                pinned to a real app registration. Queries run; the BFF mints
 *                a UAMI bearer for `LOOM_TRINO_AUDIENCE`.
 *   `sealed`   — enforcing, but pinned to the sentinel audience
 *                `api://loom-trino-sealed.invalid` because no app registration
 *                existed at deploy time. NOTHING can mint a token for it, so
 *                the engine is up and serves nobody. We do not fire a query
 *                that is guaranteed to 401 — the caller gets an honest gate.
 *   `disabled` — the explicit, audited anonymous opt-out
 *                (`loomBackends.trinoAuthMode='disabled'`).
 *
 * Unset (e.g. a pre-#2641 revision) is treated as `disabled`, which is what
 * such a revision actually is — the env-check reports it as failing.
 */
export function trinoAuthMode(): 'entra' | 'sealed' | 'disabled' {
  const raw = (process.env.LOOM_TRINO_AUTH_MODE || '').trim().toLowerCase();
  return raw === 'entra' || raw === 'sealed' ? raw : 'disabled';
}

/** True when the engine is deployed SEALED — up, enforcing, reachable by nobody. */
export function isTrinoSealed(): boolean {
  return trinoAuthMode() === 'sealed';
}

/**
 * The Trino session user. When the engine enforces Entra bearer auth, the JWT
 * principal is mapped onto ONE Trino user (`LOOM_TRINO_SESSION_USER`, default
 * `loom-console`) — Trino's default system access control DENIES impersonation,
 * so the session user must equal the mapped principal or every statement is
 * rejected. The signed-in Loom principal is not lost: it rides
 * `X-Trino-Client-Info` + a client tag, and the Cosmos `_auditLog` row written
 * by {@link logTrinoAccess} is the record of who ran what.
 */
export function trinoSessionUser(): string {
  return (process.env.LOOM_TRINO_SESSION_USER || 'loom-console').trim() || 'loom-console';
}

/**
 * LU-7 — true when this deployment publishes governance-compiled engine rules
 * to the coordinator (`LOOM_TRINO_POLICY_URL`, wired by admin-plane/main.bicep
 * alongside the same value on the loom-trino app). That document carries the
 * `impersonation` rule, so the BFF may present the signed-in Loom principal as
 * the Trino session user and let the engine enforce per-caller table rules.
 *
 * Unset → the engine is running only the catalog floor its entrypoint rendered,
 * which denies impersonation, so the mapped session user is used exactly as
 * before. Never assumed: this is a value the DEPLOY produces.
 */
export function trinoImpersonationEnabled(): boolean {
  if ((process.env.LOOM_TRINO_IMPERSONATION || '').trim().toLowerCase() === 'disabled') return false;
  return Boolean((process.env.LOOM_TRINO_POLICY_URL || '').trim());
}

/** Base URL of the internal Trino coordinator (no trailing slash, scheme-normalized). */
export function trinoBase(): string {
  const raw = (process.env.LOOM_TRINO_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * The Trino catalog name that fronts the Loom Iceberg REST Catalog on the
 * cluster (code default `iceberg`, overridable so an operator whose Trino
 * catalog properties file names it differently still resolves). This is the
 * catalog a federated join references for Loom lake tables.
 */
export function trinoIcebergCatalog(): string {
  return (process.env.LOOM_TRINO_ICEBERG_CATALOG || 'iceberg').trim() || 'iceberg';
}

export class TrinoError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'TrinoError';
    this.status = status;
    this.code = code;
  }
}

/** One column of a Trino result, with its engine-reported type. */
export interface TrinoColumn {
  name: string;
  type: string;
}

/** The normalized result shape (aligned with SqlLabResult so the UI is shared). */
export interface TrinoQueryResult {
  engine: 'trino';
  columns: TrinoColumn[];
  rows: unknown[][];
  rowCount: number;
  /** Wall-clock time the BFF measured, including every statement hop. */
  totalMs: number;
  truncated: boolean;
  maxRows: number;
  /** Distinct Trino catalogs the planner touched — federation receipt material. */
  catalogs: string[];
  /** Why this engine answered — surfaced verbatim in the UI status bar. */
  note?: string;
}

/** Shape of one page of the Trino client REST protocol (`/v1/statement`). */
interface TrinoStatementResponse {
  id?: string;
  nextUri?: string;
  columns?: Array<{ name?: string; type?: string }>;
  data?: unknown[][];
  error?: { message?: string; errorName?: string; errorCode?: number };
  stats?: { state?: string };
}

/**
 * The Entra bearer / static token forwarded on the coordinator hop. A pre-shared
 * bearer (`LOOM_TRINO_TOKEN`, Key Vault secretRef) takes precedence for a Trino
 * configured with token auth; otherwise an Entra token scoped to the cluster's
 * audience is acquired through the shared ACA-first UAMI credential chain.
 *
 * Returns `{}` when NEITHER is resolvable. That empty result is NOT a licence to
 * send the request anyway: {@link runTrinoQuery} treats it as fail-closed
 * whenever the engine is ENFORCING (`LOOM_TRINO_AUTH_MODE=entra`) and returns
 * the honest 503 gate without touching the coordinator (#2678 §2). Only in the
 * explicit `disabled` opt-out — where the engine is not enforcing at all — does
 * an unauthenticated hop actually happen, and the env-check reports THAT posture
 * as a defect. The mint failure is logged either way so it is never silent.
 */
export async function trinoAuthHeader(): Promise<Record<string, string>> {
  const preShared = (process.env.LOOM_TRINO_TOKEN || '').trim();
  if (preShared) return { authorization: `Bearer ${preShared}` };

  const audience = (process.env.LOOM_TRINO_AUDIENCE || '').trim()
    || (process.env.LOOM_MSAL_CLIENT_ID ? `api://${process.env.LOOM_MSAL_CLIENT_ID}/.default` : '');
  if (!audience) return {};

  try {
    const token = await uamiArmCredential().getToken(audience);
    if (token?.token) return { authorization: `Bearer ${token.token}` };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[trino] Entra token for %s unavailable: %s', audience, (e as Error)?.message || e);
  }
  return {};
}

/** A safe Trino `X-Trino-User` — the coordinator rejects control chars / spaces. */
function trinoUser(upn: string | undefined): string {
  const u = String(upn || 'loom-console').replace(/[^\w.@-]/g, '_').slice(0, 128);
  return u || 'loom-console';
}

/**
 * Does this failure mean the coordinator refused to let the mapped session user
 * become the signed-in caller? Trino reports that as `USER_CANNOT_BE_IMPERSONATED`
 * (403), and older/edge builds surface it as a plain access-denied naming
 * impersonation. Matched narrowly so a genuine authorization denial on the DATA
 * is never retried with a wider identity.
 */
function isImpersonationDenial(e: unknown): boolean {
  if (!(e instanceof TrinoError)) return false;
  const code = (e.code || '').toUpperCase();
  if (code === 'USER_CANNOT_BE_IMPERSONATED') return true;
  const msg = (e.message || '').toLowerCase();
  return e.status === 403 && msg.includes('impersonat');
}

/**
 * Per-hop budget for the Trino statement protocol.
 *
 * The default-ON deployment (data-plane/loom-trino-aca.bicep) runs the engine
 * with `minReplicas: 0` — that scale-to-zero posture is exactly what makes
 * default-ON affordable, and it means the FIRST request after an idle period
 * waits on a JVM cold start (~20-40s) while Container Apps activates the
 * replica. The shared 30s server default would abort that activation and
 * report an unreachable coordinator, so this hop gets its own, larger ceiling.
 * Subsequent pages of the same statement return in milliseconds.
 *
 * Override per-deployment with LOOM_TRINO_FETCH_TIMEOUT_MS.
 */
export const TRINO_FETCH_TIMEOUT_MS: number = (() => {
  const n = Number(process.env.LOOM_TRINO_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
})();

/** GET/POST one page of the statement protocol, mapping failure to TrinoError. */
async function trinoFetch(
  url: string,
  init: { method: 'POST' | 'GET'; body?: string; headers: Record<string, string> },
): Promise<TrinoStatementResponse> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    }, TRINO_FETCH_TIMEOUT_MS);
  } catch (e) {
    throw new TrinoError(
      `The Trino coordinator at ${trinoBase()} was unreachable: ${(e as Error)?.message || String(e)}`,
      502,
      'unreachable',
    );
  }
  const text = await res.text();
  let body: TrinoStatementResponse | null = null;
  try { body = text ? (JSON.parse(text) as TrinoStatementResponse) : null; } catch { body = null; }
  // 503 with a nextUri is Trino back-pressure (retry the same URI) — the caller
  // loop handles it; only a hard non-2xx WITHOUT a body is a transport failure.
  if (!res.ok && res.status !== 503) {
    throw new TrinoError(
      body?.error?.message || text.slice(0, 400) || `Trino request failed (HTTP ${res.status})`,
      res.status,
      body?.error?.errorName || 'query_failed',
    );
  }
  return body ?? {};
}

/**
 * Run one federated statement on the opt-in Trino cluster via the client REST
 * protocol: POST `/v1/statement`, then follow `nextUri` until the query drains,
 * accumulating columns + rows (bounded by `maxRows` and a hard page cap so a
 * runaway federation can never spin the BFF). Throws {@link TrinoError} —
 * including 503 `not_configured` when `LOOM_TRINO_URL` is unset, so the route
 * renders the honest opt-in gate rather than a fabricated result.
 */
export async function runTrinoQuery(
  sql: string,
  opts: {
    maxRows?: number;
    actorUpn?: string;
    catalog?: string;
    schema?: string;
    knownCatalogs?: string[];
    /**
     * LU-7 internal — force the mapped session user instead of impersonating the
     * signed-in caller. Set only by the self-healing retry when the engine has
     * not yet loaded the governance rules (and therefore denies impersonation).
     */
    forceMappedUser?: boolean;
  },
): Promise<TrinoQueryResult> {
  if (!isTrinoConfigured()) {
    throw new TrinoError(
      'The Federated SQL (Trino) engine is not present in this environment (LOOM_TRINO_URL is unset). '
      + 'It is DEFAULT-ON, so this normally means the admin-plane deployment has not been re-run since the '
      + 'engine shipped, the loom-trino image is not in this ACR yet, or an operator set '
      + "loomBackends.trino='disabled'. Re-run the admin-plane deployment — it stands up "
      + 'data-plane/loom-trino-aca.bicep (single-node Trino, internal ingress, minReplicas 0 so idle cost is '
      + 'nothing) and wires this var. SQL Lab keeps running on DuckDB / Synapse Serverless meanwhile.',
      503,
      'not_configured',
    );
  }
  if (isTrinoSealed()) {
    // Enforcing against an audience nothing can mint. Firing the statement
    // would burn a cold start and come back 401 — say the true thing instead.
    throw new TrinoError(
      'The Federated SQL (Trino) engine is deployed SEALED: engine-level Entra authorization is ENFORCED, '
      + 'but no app registration was available at deploy time, so the accepted audience is the sentinel '
      + '"api://loom-trino-sealed.invalid" that nothing can mint a token for. The engine is up and costs '
      + 'nothing (minReplicas 0); it accepts no caller. Fix: run the sign-in bootstrap '
      + '(.github/workflows/csa-loom-post-deploy-bootstrap.yml) so an Entra app registration exists, then '
      + 'redeploy with LOOM_MSAL_CLIENT_ID set (or pin a dedicated one with '
      + "loomBackends.trinoAudienceClientId). SQL Lab keeps serving on DuckDB / Synapse Serverless meanwhile.",
      503,
      'sealed',
    );
  }
  const started = Date.now();
  const maxRows = Math.max(1, Math.min(opts.maxRows ?? 5_000, 200_000));
  const enforcing = trinoAuthMode() === 'entra';
  // LU-7 — present the real signed-in principal when the deployment publishes
  // governance-compiled rules (which carry the impersonation rule that permits
  // it). `opts.forceMappedUser` is the self-healing retry path below.
  const impersonate = trinoImpersonationEnabled() && !opts.forceMappedUser;
  const authHeaders = await trinoAuthHeader();
  // ROUND-4 (#2678) — FAIL CLOSED, do not fall through unauthenticated.
  //
  // When the engine is ENFORCING (authMode=entra) but no bearer could be minted
  // — the pinned audience `api://<clientId>` is not a registered Application ID
  // URI yet, so the token request fails with AADSTS500011 (see #2678 §1) — the
  // old code sent the statement with NO Authorization header and earned an
  // opaque 401 from the coordinator WHILE the operator was told the posture was
  // "enforced + reachable". A default-ON query engine must never quietly send an
  // unauthenticated request. Return the honest gate instead and never touch the
  // coordinator. (In `disabled` mode the engine is not enforcing, so no bearer
  // is required — the anonymous VNet-only opt-out; the env-check flags it.)
  if (enforcing && !authHeaders.authorization) {
    throw new TrinoError(
      'The Federated SQL (Trino) engine is ENFORCING Entra authorization but the Console could not mint a '
      + 'bearer for the pinned audience (LOOM_TRINO_AUDIENCE). This is the expected state until the audience '
      + 'is a registered Application ID URI on the accepting app registration — an unregistered resource URI '
      + 'fails token acquisition with AADSTS500011 before the engine ever sees the request. The query was NOT '
      + 'sent unauthenticated. Fix: register the App ID URI (or pin loomBackends.trinoAudienceClientId to an '
      + 'app that exposes one) and confirm the decoded token `aud`. SQL Lab keeps serving on DuckDB / Synapse '
      + 'Serverless meanwhile.',
      503,
      'auth_unavailable',
    );
  }
  const headers: Record<string, string> = {
    'content-type': 'text/plain',
    accept: 'application/json',
    // LU-7 — WHO the engine thinks is asking.
    //
    // Historically this was pinned to the mapped session user whenever
    // authorization was enforcing, because Trino's DEFAULT access control denies
    // impersonation: the session user had to equal the principal the JWT mapped
    // to, so the engine could not tell Loom callers apart and per-caller policy
    // could only live at the BFF.
    //
    // The governance-compiled rules document (compilers/trino.ts) emits an
    // `impersonation` rule permitting exactly the mapped session user to become
    // any `new_user`, which is what lets us present the REAL signed-in principal
    // so the engine's own user/group table rules — including row filters and
    // column masks — evaluate against them. `trinoImpersonationEnabled()` is
    // true only when this deployment wired the policy URL, i.e. when the engine
    // is being served that document.
    //
    // If the engine has NOT yet fetched it (first boot, Console briefly
    // unreachable) it is still running the catalog floor, which has no
    // impersonation rule and would reject the impersonated user. That is a
    // self-healing condition, not an outage: the statement is retried once with
    // the mapped session user, and the retry is logged.
    'x-trino-user': enforcing && !impersonate ? trinoSessionUser() : trinoUser(opts.actorUpn),
    'x-trino-source': 'csa-loom-sql-lab',
    'x-trino-client-info': JSON.stringify({ loomUser: trinoUser(opts.actorUpn) }),
    'x-trino-client-tags': `loom-user=${trinoUser(opts.actorUpn)}`,
    ...(opts.catalog ? { 'x-trino-catalog': opts.catalog } : {}),
    ...(opts.schema ? { 'x-trino-schema': opts.schema } : {}),
    ...authHeaders,
  };

  const columns: TrinoColumn[] = [];
  const rows: unknown[][] = [];
  // The catalogs the AUTHORIZED statement referenced — supplied by the route's
  // authorization pass (trino-authz.extractReferencedCatalogs), which is the
  // same set the caller was authorized against. Falls back to any catalogs the
  // planner reports inline. This is the federation receipt on the audit row.
  const catalogs = new Set<string>((opts.knownCatalogs || []).filter(Boolean));
  let truncated = false;

  // POST the statement, then walk the nextUri chain (bounded: 5000 pages).
  let page: TrinoStatementResponse;
  try {
    page = await trinoFetch(`${trinoBase()}/v1/statement`, { method: 'POST', body: sql, headers });
  } catch (e) {
    // LU-7 self-heal: we asked the engine to accept the signed-in principal as
    // the session user, and it refused. That means the engine is still running
    // the catalog floor from its start-up (it has not fetched the
    // governance-compiled document, which carries the impersonation rule) —
    // transient by construction, since the entrypoint retries on its refresh
    // loop. Retry ONCE as the mapped session user so a policy-publication lag
    // never becomes a query outage, and say so in the log rather than silently
    // downgrading.
    if (impersonate && isImpersonationDenial(e)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[trino] the coordinator denied impersonation of %s, so it has not loaded the governance-compiled '
        + 'rules yet (LOOM_TRINO_POLICY_URL is wired but the engine is still on its start-up catalog floor). '
        + 'Retrying as the mapped session user; engine-level per-caller policy is NOT in force for this query.',
        trinoUser(opts.actorUpn),
      );
      return runTrinoQuery(sql, { ...opts, forceMappedUser: true });
    }
    throw e;
  }
  const MAX_PAGES = 5_000;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    if (page.error) {
      throw new TrinoError(
        page.error.message || 'Trino query failed',
        400,
        page.error.errorName || 'query_failed',
      );
    }
    if (columns.length === 0 && Array.isArray(page.columns)) {
      for (const c of page.columns) columns.push({ name: String(c?.name ?? ''), type: String(c?.type ?? '') });
    }
    if (Array.isArray(page.data)) {
      for (const r of page.data) {
        if (rows.length >= maxRows) { truncated = true; break; }
        rows.push(r as unknown[]);
      }
    }
    if (!page.nextUri || (truncated && rows.length >= maxRows)) break;
    // nextUri is an absolute URL the coordinator hands back; follow it verbatim.
    page = await trinoFetch(page.nextUri, { method: 'GET', headers });
  }

  return {
    engine: 'trino',
    columns,
    rows,
    rowCount: rows.length,
    totalMs: Date.now() - started,
    truncated,
    maxRows,
    catalogs: Array.from(catalogs),
    note:
      'Executed on the opt-in Trino federation cluster (AKS, in your VNet). Federated SQL can join Loom '
      + 'Iceberg tables with external sources in one statement.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-source join builder (server-built — identifiers go through the quoting
// helper, never inline). Trino uses ANSI delimited identifiers ("cat"."sch"."t").
// ─────────────────────────────────────────────────────────────────────────────

/** A fully-qualified Trino table in Loom's own coordinates. */
export interface TrinoTableRef {
  /** Trino catalog (e.g. the Iceberg catalog `iceberg`, or an external `postgres`). */
  catalog: string;
  schema: string;
  table: string;
}

/** Validate one identifier level (catalog / schema / table). */
function assertTrinoIdent(value: string, kind: string): string {
  const v = String(value ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v)) {
    throw new TrinoError(`"${v}" is not a valid Trino ${kind} identifier`, 400, 'invalid_identifier');
  }
  return v;
}

/**
 * Build the `"catalog"."schema"."table"` reference for a Trino table, each level
 * validated and bracketed via the shared `quoteIdent(name, 'trino')` (ANSI
 * double-quote, injection-safe) — never inline-escaped (.claude sql-quoting rule).
 */
export function trinoTableRef(ref: TrinoTableRef): string {
  const catalog = assertTrinoIdent(ref.catalog, 'catalog');
  const schema = assertTrinoIdent(ref.schema, 'schema');
  const table = assertTrinoIdent(ref.table, 'table');
  return [catalog, schema, table].map((p) => quoteIdent(p, 'trino')).join('.');
}

/**
 * Build a well-formed cross-source join statement: the canonical N7e federation
 * example — a Loom Iceberg table joined to an external source (e.g. Postgres) in
 * ONE statement. Identifiers are all resolved through {@link trinoTableRef} /
 * {@link quoteIdent}. `columns` is a whitelist of already-validated projection
 * expressions (caller-controlled, defaulting to `*`).
 */
export function buildFederatedJoinSql(args: {
  left: TrinoTableRef;
  right: TrinoTableRef;
  /** Equi-join key pairs: [leftColumn, rightColumn][]. */
  on: Array<[string, string]>;
  columns?: string[];
  limit?: number;
}): string {
  const left = trinoTableRef(args.left);
  const right = trinoTableRef(args.right);
  if (!Array.isArray(args.on) || args.on.length === 0) {
    throw new TrinoError('A federated join needs at least one ON key pair.', 400, 'invalid_join');
  }
  const onClause = args.on
    .map(([l, r]) => `l.${quoteIdent(assertTrinoIdent(l, 'column'), 'trino')} `
      + `= r.${quoteIdent(assertTrinoIdent(r, 'column'), 'trino')}`)
    .join(' AND ');
  const projection = args.columns && args.columns.length ? args.columns.join(', ') : '*';
  const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 100), 200_000));
  return `SELECT ${projection} FROM ${left} AS l JOIN ${right} AS r ON ${onClause} LIMIT ${limit}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audited data-plane access log
// ─────────────────────────────────────────────────────────────────────────────

export interface TrinoAccessEvent {
  actorOid: string;
  actorUpn: string;
  tenantId: string;
  /** The statement (truncated in the row) — the "scope" of a federated access. */
  sql: string;
  /** Distinct Trino catalogs the planner touched (federation footprint). */
  catalogs?: string[];
  workspaceId?: string;
  itemId?: string;
  outcome: 'success' | 'failure';
  rowCount?: number;
  elapsedMs?: number;
  detail?: string;
}

/**
 * Write ONE `_auditLog` data-access row for a federated Trino query and fan it
 * out through the SIEM / webhook audit stream. Best-effort by design: an
 * audit-store failure must never turn a successful read into a 500, but it IS
 * logged.
 */
export async function logTrinoAccess(ev: TrinoAccessEvent): Promise<void> {
  const at = new Date().toISOString();
  const statement = (ev.sql || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const catalogs = (ev.catalogs || []).filter(Boolean);
  const summary =
    `Federated SQL (Trino) query by ${ev.actorUpn}`
    + (catalogs.length ? ` across ${catalogs.join(', ')}` : '')
    + (ev.rowCount === undefined ? '' : ` (${ev.rowCount} row(s))`)
    + (ev.outcome === 'failure' ? ` — FAILED: ${(ev.detail || '').slice(0, 200)}` : '');

  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: ev.tenantId,
      itemId: ev.itemId || 'sql-lab',
      itemType: 'sql-lab',
      action: 'trino.sql.query',
      summary,
      engine: 'trino',
      statement,
      catalogs,
      workspaceId: ev.workspaceId || '',
      outcome: ev.outcome,
      rowCount: ev.rowCount ?? null,
      elapsedMs: ev.elapsedMs ?? null,
      upn: ev.actorUpn,
      actorOid: ev.actorOid,
      at,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[trino] audit row write failed:', (e as Error)?.message || e);
  }

  try {
    emitAuditEvent({
      actorOid: ev.actorOid,
      actorUpn: ev.actorUpn,
      action: 'trino.sql.query',
      targetType: 'sql-lab',
      targetId: ev.itemId || 'sql-lab',
      outcome: ev.outcome,
      tenantId: ev.tenantId,
      timestamp: at,
      detail: {
        engine: 'trino',
        statement,
        catalogs,
        workspaceId: ev.workspaceId || '',
        rowCount: ev.rowCount ?? null,
        elapsedMs: ev.elapsedMs ?? null,
        ...(ev.detail ? { detail: ev.detail.slice(0, 400) } : {}),
      },
    });
  } catch {
    /* audit-stream fan-out is best-effort by contract */
  }
}
