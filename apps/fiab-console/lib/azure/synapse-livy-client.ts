/**
 * Synapse Spark Livy interactive-session client — F16 per-cell notebook
 * execution. Talks to the Synapse dev endpoint Livy API:
 *
 *   https://{ws}.dev.azuresynapse.net/livyApi/versions/2019-11-01-preview
 *     /sparkPools/{pool}/sessions[...]
 *
 * Adds, beyond what synapse-dev-client.ts already had:
 *   - killLivySession    (DELETE .../sessions/{id})    — session teardown
 *   - keepaliveLivySession (PUT .../sessions/{id}/keepalive) — idle reset
 *   - parseMagicKind / parseConfigureMagic — Synapse %%-magic interception
 *   - normalizeLivyOutput — text/plain, text/html, application/json (df) → table,
 *     image/png passthrough for display(df) rich rendering
 *   - resolveNotebookBackend — LOOM_NOTEBOOK_BACKEND opt-in routing
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential), DEV_SCOPE
 * (https://dev.azuresynapse.net/.default) — identical to synapse-dev-client.
 * The console UAMI needs the Synapse data-plane role "Synapse Compute Operator"
 * at the Spark-pool scope to submit interactive sessions/statements (granted by
 * the consoleSparkSubmitRoleScript deployment-script in synapse.bicep).
 *
 * No mocks. Every network call hits the real Livy REST surface and surfaces
 * errors verbatim. synapse-dev-client re-exports the session/statement helpers
 * from here for backward-compat with the existing run-cell route.
 *
 * Learn:
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-session
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-statement
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/get-spark-statement
 *   https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks (magic commands)
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { PagingBudget, PAGE_DEADLINE, type PagingTruncation } from '@/lib/azure/paging-budget';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const DEV_SCOPE = 'https://dev.azuresynapse.net/.default';
const LIVY_API = '2019-11-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function ws(): string {
  const v = process.env.LOOM_SYNAPSE_WORKSPACE;
  if (!v) throw new Error('Missing env var: LOOM_SYNAPSE_WORKSPACE');
  return v;
}

function devBase(): string {
  // Sovereign-cloud aware (parity with synapse-dev-client.ts::devBase). Prefer
  // the explicit LOOM_SYNAPSE_DEV_SUFFIX (e.g. `azuresynapse.us` for GCC-High /
  // DoD) so Livy calls hit the right dev endpoint; default to the Commercial
  // host. Without this the perf/telemetry reads 404 in Gov and the persona
  // silently falls back (best-effort), but parity demands the real endpoint.
  const suffix = process.env.LOOM_SYNAPSE_DEV_SUFFIX;
  if (suffix) return `https://${ws()}.dev.${suffix.replace(/^\.+|\/+$/g, '')}`;
  return `https://${ws()}.dev.azuresynapse.net`;
}

function livyBase(pool: string): string {
  return `${devBase()}/livyApi/versions/${LIVY_API}/sparkPools/${encodeURIComponent(pool)}`;
}

async function callDev(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  const tok = await credential.getToken(DEV_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire Synapse dev token');
  return fetchWithTimeout(
    url,
    {
      ...init,
      headers: {
        ...(init?.headers || {}),
        authorization: `Bearer ${tok.token}`,
        'content-type': 'application/json',
      },
    },
    timeoutMs,
  );
}

async function jsonOrThrow<T>(r: Response, label: string): Promise<T> {
  if (!r.ok && r.status !== 202) {
    throw new Error(`${label} failed ${r.status}: ${await r.text()}`);
  }
  const text = await r.text();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { return {} as T; }
}

// ============================================================
// Types
// ============================================================

export type LivyKind = 'pyspark' | 'spark' | 'sql' | 'sparkr';
export type MagicKind = LivyKind;

export interface LivySessionOptions {
  kind: LivyKind;
  name?: string;
  driverMemory?: string;
  driverCores?: number;
  executorMemory?: string;
  executorCores?: number;
  numExecutors?: number;
  conf?: Record<string, string>;
}

/** Synapse Livy's per-session error detail (detailed=true), e.g. the
 * MAX_QUEUED_JOBS_PER_COMPUTE_EXCEEDED queue-jam rejection. */
export interface LivySessionErrorInfo {
  message?: string;
  errorCode?: string;
  source?: string;
}

export interface LivySession {
  id: number;
  state: string;
  kind?: string;
  /** Session name (present when the list/get call passes detailed=true). */
  name?: string | null;
  appId?: string | null;
  appInfo?: { sparkUiUrl?: string; driverLogUrl?: string } | null;
  log?: string[];
  errorInfo?: LivySessionErrorInfo[] | null;
}

/** Human-readable summary of a terminal session's errorInfo ('' when none). */
export function livyErrorDetail(sess: Pick<LivySession, 'errorInfo'>): string {
  return (sess.errorInfo || [])
    .map((e) => e?.message || e?.errorCode || '')
    .filter(Boolean)
    .join('; ');
}

export interface LivyStatementOutput {
  status: 'ok' | 'error';
  execution_count?: number;
  data?: {
    'text/plain'?: string | string[];
    'text/html'?: string | string[];
    'application/json'?: unknown;
    'image/png'?: string;
  };
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface LivyStatement {
  id: number;
  state: string;
  output?: LivyStatementOutput | null;
  progress?: number;
}

export interface NormalizedOutput {
  status: 'ok' | 'error';
  textPlain?: string;
  textHtml?: string;
  tableColumns?: string[];
  tableRows?: string[][];
  imageBase64?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

// ============================================================
// Session lifecycle
// ============================================================

export async function createLivySession(
  poolName: string,
  opts: LivySessionOptions,
): Promise<LivySession> {
  const body: Record<string, unknown> = {
    kind: opts.kind,
    name: opts.name || `loom-session-${Date.now()}`,
    driverMemory: opts.driverMemory || '4g',
    driverCores: opts.driverCores ?? 4,
    executorMemory: opts.executorMemory || '4g',
    executorCores: opts.executorCores ?? 4,
    numExecutors: opts.numExecutors ?? 2,
  };
  if (opts.conf && Object.keys(opts.conf).length) body.conf = opts.conf;
  const r = await callDev(`${livyBase(poolName)}/sessions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return jsonOrThrow<LivySession>(r, `createLivySession(${poolName})`);
}

export async function getLivySession(poolName: string, sessionId: number): Promise<LivySession> {
  // detailed=true adds `errorInfo` so a terminal session's REAL failure reason
  // (e.g. the MAX_QUEUED_JOBS_PER_COMPUTE_EXCEEDED queue-jam rejection) reaches
  // the editor instead of an opaque "entered terminal state 'error'".
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}?detailed=true`);
  return jsonOrThrow<LivySession>(r, `getLivySession(${poolName}/${sessionId})`);
}

/**
 * The Livy SESSIONS list endpoint carries the IDENTICAL per-request cap as the
 * batches endpoint: "size — Optional param specifying the size of the returned
 * list. By default it is 20 and that is the maximum."
 * (https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/get-spark-sessions)
 *
 * `listLivySessions` defaulted `pageSize` to 100 and never validated it — the
 * exact defect #3568 reported against `listSparkBatchJobs`, on the sibling
 * endpoint. Clamping it here is only half the fix: at size=100 the old guard
 * `ceil(hardCap/size)+1` allowed 21 pages, but at the correct size=20 the same
 * expression allows 101 — so a bare clamp makes the UNBOUNDED-TIME problem
 * five times worse. The clamp therefore ships together with a
 * {@link PagingBudget} that bounds the walk in pages AND wall clock, and with
 * a truncation signal so a caller can tell a COMPLETE census from a partial
 * one instead of quietly acting on a short list.
 */
const LIVY_MAX_PAGE_SIZE = 20;

/** What a bounded session census collected, and whether it is the WHOLE list. */
export interface LivySessionCensus {
  sessions: LivySession[];
  /**
   * The session count this census can stand behind: the server's `total` when
   * it reported one that CANNOT be the length of a single page, otherwise the
   * number of distinct sessions actually collected. Never a number this client
   * invented — see the `total > batch.length` note in `listLivySessionsResult`.
   */
  total: number;
  /** How many distinct sessions the walk actually collected. */
  scanned: number;
  /**
   * Non-null when a ceiling cut the walk short — the census is INCOMPLETE and
   * MUST NOT be treated as "these are all the sessions that exist". See the
   * caller note on {@link listLivySessions}.
   */
  truncatedBy: PagingTruncation | null;
}

/**
 * Enumerate ALL interactive Livy sessions on a Spark pool (paged), reporting
 * whether the census is complete.
 *
 * Livy's list endpoint returns `{ from, total, sessions }` and caps a page at
 * 20 rows, so we page with `from`/`size` until we've collected `total`, the
 * server runs dry, `hardCap` rows are reached, or the budget trips. Every
 * fetch — including the first — goes through `claimPage()` + `runPage()`, so
 * the walk is bounded in wall clock and not merely in page count: a fetch
 * issued outside `runPage` gets `DEFAULT_SERVER_FETCH_TIMEOUT_MS` (30s) of its
 * own, which is how a "bounded" loop silently becomes 100 x 30s.
 *
 * Used by the warm-pool stale-session REAPER (#1796) to find leaked sessions
 * from crashed runs/replicas that hold vcores with no active lease and starve
 * new sessions, and by the admin Spark-health census. Real Livy REST, no mocks.
 */
export async function listLivySessionsResult(
  poolName: string,
  opts?: { pageSize?: number; hardCap?: number; budgetMs?: number },
): Promise<LivySessionCensus> {
  // `pageSize` and `hardCap` arrive from callers and from config, so they get
  // the NON-FINITE guard the sibling `clampLivyPageSize` in livy-batch-paging.ts
  // has and this function lacked. Two values were silently wrong rather than
  // rejected:
  //
  //   pageSize: NaN → `Math.floor(NaN)` is NaN, `Math.max(1, NaN)` is NaN, the
  //     request went out as `size=NaN`, AND `maxPages: ceil(hardCap/NaN)` was
  //     NaN — which `claimPage()` evaluates as `0 < NaN` = false. Zero pages
  //     fetched, an EMPTY census, and `truncatedBy` from a budget that never ran.
  //   pageSize: 0  → floored to 1, turning the documented 2000-ROW `hardCap`
  //     into a 2000-PAGE ceiling: 2000 budgeted requests to read one pool.
  //
  // A page size below 1 is not a smaller request, it is a nonsense one, so it
  // falls back to the documented default instead of to 1. (That is the one
  // place this deliberately differs from `clampLivyPageSize`, which floors to 1
  // because it only ever sees an internally-computed remainder, never a
  // caller's value.)
  const asPageSize = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) && Math.floor(v) >= 1
      ? Math.floor(v)
      : LIVY_MAX_PAGE_SIZE;
  const size = Math.min(LIVY_MAX_PAGE_SIZE, asPageSize(opts?.pageSize));
  const rawCap = typeof opts?.hardCap === 'number' && Number.isFinite(opts.hardCap)
    ? Math.floor(opts.hardCap)
    : 2000;
  const hardCap = Math.max(size, rawCap);
  // `hardCap` keeps its documented meaning — a ROW ceiling — by translating it
  // into the budget's page cap at the (now correct) page size.
  const budget = new PagingBudget(`listLivySessions(${poolName})`, {
    maxPages: Math.ceil(hardCap / size),
    ...(opts?.budgetMs ? { budgetMs: opts.budgetMs } : {}),
  });

  const out: LivySession[] = [];
  const seen = new Set<number>();
  let from = 0;
  // `null` = the server never reported a `total`. It used to be initialised to
  // 0, which made `out.length >= total` true as `20 >= 0` after the very first
  // page: the walk broke immediately and reported `truncatedBy: null`, so a
  // 20-row subset of a 137-session pool read as a COMPLETE census. That is not
  // merely a short list — `reapStaleSessions` gates its tracker GC on exactly
  // this field, so a `total`-less backend walks straight past that guard and
  // the reaper forgets the grace window of every session it never paged to.
  let total: number | null = null;
  // Completeness has to be ESTABLISHED, not assumed. Only two things establish
  // it: the server ran the list dry, or it reported a total and we reached it.
  let ranDry = false;
  // Set by any page whose body carried NO `sessions` array. That is a broken
  // read, not an exhausted list, and the two must not collapse — see below.
  let malformed = false;

  while (out.length < hardCap && budget.claimPage()) {
    // detailed=true adds `name` (and errorInfo) — the reaper's busy-zombie rule
    // matches pool-owned sessions by their loom-warmpool-* name.
    const page = await budget.runPage((timeoutMs) =>
      callDev(
        `${livyBase(poolName)}/sessions?from=${from}&size=${size}&detailed=true`,
        undefined,
        timeoutMs,
      ).then((r) =>
        jsonOrThrow<{ from?: number; total?: number; sessions?: LivySession[] }>(
          r,
          `listLivySessions(${poolName})`,
        ),
      ),
    );
    if (page === PAGE_DEADLINE) break; // wall clock spent mid-fetch — keep rows
    if (!Array.isArray(page.sessions)) {
      // A 200 whose body has no `sessions` array ANSWERED NOTHING. Treating it
      // as an empty page (which `Array.isArray(...) ? ... : []` did) set
      // `ranDry` on the next line and handed the reaper a "complete" census of
      // whatever had been read so far. `livy-session-census.py` in this same PR
      // already refuses that inference — "cannot distinguish an exhausted list
      // from a broken response" — and this is the TypeScript side of the same
      // rule.
      malformed = true;
      break;
    }
    const batch = page.sessions;
    for (const s of batch) {
      if (typeof s?.id === 'number' && seen.has(s.id)) continue;
      if (typeof s?.id === 'number') seen.add(s.id);
      out.push(s);
    }
    // TRUST `total` ONLY WHEN IT CANNOT BE THIS PAGE'S OWN LENGTH.
    //
    // Synapse's REST spec — the one swagger that generates the JS, Java and
    // .NET SDKs — describes the batch collection's sibling field as "Number of
    // sessions fetched", i.e. the page length, while Apache Livy's server means
    // `sessionManager.size()`, i.e. the pool. `SparkSessionCollection` in that
    // same swagger carries NO description at all, so this endpoint's contract
    // is weaker still.
    //
    // Under the page-length reading a 137-session pool answers page one with
    // `total: 20` next to 20 rows, `out.length >= total` is `20 >= 20`, and the
    // walk breaks after ONE page with `truncatedBy: null` — a 20-of-137 subset
    // reported as a COMPLETE census. `reapStaleSessions` gates its tracker GC
    // on exactly that field, so it then forgets the grace window of the 117
    // sessions this never paged to: #1796, reopened.
    //
    // `total > batch.length` is the one observation impossible under the
    // page-length reading (a page length cannot exceed itself), so it alone is
    // treated as evidence of a pool-wide count. Everything else leaves `total`
    // null and lets the walk end the only way that is honest under BOTH
    // readings: an empty page. On a pool holding one page or less that costs
    // one extra request, and `total ?? out.length` still reports the exact
    // count.
    if (
      typeof page.total === 'number' &&
      Number.isFinite(page.total) &&
      page.total > batch.length
    ) {
      total = page.total;
    }
    from += batch.length;
    if (batch.length === 0) {
      ranDry = true; // the server ran dry — complete, and NOT a truncation
      break;
    }
    if (total !== null && out.length >= total) break; // reached the reported total
  }

  budget.warnIfTruncated(out.length);
  // Silence must mean "this list is whole". Anything else — the row cap, the
  // page cap, a broken page, or a walk that simply never reached an end it
  // could verify — is a truncation the caller has to see.
  const sawWholeList = !malformed && (ranDry || (total !== null && out.length >= total));
  return {
    sessions: out.slice(0, hardCap),
    total: total ?? out.length,
    scanned: out.length,
    truncatedBy: budget.truncatedBy ?? (sawWholeList ? null : 'pages'),
  };
}

/**
 * {@link listLivySessionsResult} for callers that only want the rows.
 *
 * CALLER WARNING: this shape CANNOT express an incomplete census. Any caller
 * that treats "not in this array" as "no longer exists on the pool" must use
 * `listLivySessionsResult` and check `truncatedBy` first — `reapStaleSessions`
 * in `spark-session-pool.ts` does exactly that with its `liveIds` tracker GC,
 * and on a truncated census would forget the grace-window timestamps of
 * sessions that are still very much alive.
 */
export async function listLivySessions(
  poolName: string,
  opts?: { pageSize?: number; hardCap?: number; budgetMs?: number },
): Promise<LivySession[]> {
  return (await listLivySessionsResult(poolName, opts)).sessions;
}

/**
 * Kill an interactive Livy session (DELETE). Returns {"msg":"deleted"} on
 * success. A 404 means the session is already gone — treat as success so the
 * editor's kill-on-unmount never throws.
 */
/**
 * Fetch a slice of the Livy session DRIVER LOG — the stdout/stderr stream the
 * Spark driver writes (Databricks/Synapse notebook parity: the "driver logs"
 * pane). `from:-1`-style tailing isn't in the Synapse Livy surface, so callers
 * tail by passing from = max(0, total - size) from the previous response.
 *   GET {livyBase(pool)}/sessions/{id}/log?from=&size=
 *   → { id, from, total, log: string[] }
 *
 * NO LEARN CITATION ON PURPOSE. This used to cite
 * `rest/api/synapse/data-plane/spark-session/get-spark-session-log`, but
 * Synapse's Livy-compat surface does not implement `/log` — this PR's own table
 * records that path 404ing, and the fallback below exists precisely because it
 * does. Citing a reference for behaviour we measured to be absent is the same
 * class of untrue statement as the error strings in `deploy-integrity.md` R7.
 * The 404 fallback is the contract; see the live receipt in its comment.
 */
export async function getLivySessionLog(
  poolName: string,
  sessionId: number,
  from = 0,
  size = 200,
): Promise<{ from: number; total: number; log: string[] }> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/log?from=${from}&size=${size}`);
  if (r.status === 404) {
    // Synapse's Livy-compat surface doesn't implement /log (live 404 receipt
    // 2026-07-17: getLivySessionLog(loometl/36) 404 while statements on the
    // same session worked). The detailed session read carries the same Livy
    // log tail in its `log` array — slice it to honor the caller's window.
    const rs = await callDev(`${livyBase(poolName)}/sessions/${sessionId}?detailed=true`);
    const s = await jsonOrThrow<{ log?: string[] }>(rs, `getLivySession(${poolName}/${sessionId})`);
    const all = Array.isArray(s.log) ? s.log : [];
    const start = Math.max(0, Math.min(from, all.length));
    return { from: start, total: all.length, log: all.slice(start, start + size) };
  }
  const body = await jsonOrThrow<{ from?: number; total?: number; log?: string[] }>(r, `getLivySessionLog(${poolName}/${sessionId})`);
  return { from: body.from ?? from, total: body.total ?? 0, log: Array.isArray(body.log) ? body.log : [] };
}

export async function killLivySession(poolName: string, sessionId: number): Promise<void> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 204 && r.status !== 404) {
    throw new Error(`killLivySession failed ${r.status}: ${await r.text()}`);
  }
}

/**
 * Reset the session idle-timeout clock (PUT .../keepalive). The editor calls
 * this every ~4 minutes while a notebook is open so a warm session survives
 * between cell runs. A 404 means the session already died — swallow it.
 */
export async function keepaliveLivySession(poolName: string, sessionId: number): Promise<void> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/keepalive`, { method: 'PUT' });
  if (!r.ok && r.status !== 200 && r.status !== 204 && r.status !== 404) {
    throw new Error(`keepaliveLivySession failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Statements
// ============================================================

export async function submitLivyStatement(
  poolName: string,
  sessionId: number,
  code: string,
  kind: LivyKind,
): Promise<LivyStatement> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/statements`, {
    method: 'POST',
    body: JSON.stringify({ code, kind }),
  });
  return jsonOrThrow<LivyStatement>(r, `submitLivyStatement(${poolName}/${sessionId})`);
}

export async function getLivyStatement(
  poolName: string,
  sessionId: number,
  stmtId: number,
): Promise<LivyStatement> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/statements/${stmtId}`);
  return jsonOrThrow<LivyStatement>(r, `getLivyStatement(${poolName}/${sessionId}/${stmtId})`);
}

/**
 * Cancel a running Livy statement — the backing for the notebook cell "Stop"
 * control (a structured-streaming cell with awaitTermination() otherwise runs
 * forever and the cell shows "running" indefinitely).
 *   POST {livyBase(pool)}/sessions/{id}/statements/{stmtId}/cancel
 * Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/cancel-spark-statement
 */
export async function cancelLivyStatement(
  poolName: string,
  sessionId: number,
  stmtId: number,
): Promise<void> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/statements/${stmtId}/cancel`, {
    method: 'POST',
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`cancelLivyStatement(${poolName}/${sessionId}/${stmtId}) failed ${r.status}: ${text.slice(0, 200)}`);
  }
}

interface LivyStatementsResponse {
  from?: number;
  total?: number;
  statements?: LivyStatement[];
}

/**
 * List ALL statements submitted to a Livy session, in submission order.
 *   GET {livyBase(pool)}/sessions/{id}/statements
 *   → { from, total, statements: LivyStatement[] }  (LivyStatementsResponseBody)
 * Used by the in-cell Copilot /fix path to pull the most recent error a cell
 * produced straight from the live Spark session, not from cached client state.
 *
 * Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/list-spark-statements
 */
export async function listLivyStatements(
  poolName: string,
  sessionId: number,
): Promise<LivyStatement[]> {
  const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/statements`);
  const body = await jsonOrThrow<LivyStatementsResponse>(r, `listLivyStatements(${poolName}/${sessionId})`);
  return Array.isArray(body.statements) ? body.statements : [];
}

/**
 * Fetch the most recent error output from a live Livy session — the real
 * backing for the in-cell Copilot /fix command. Scans completed statements
 * (state 'available') with an error output and returns the highest-id one's
 * normalized error fields. Returns null when there is no error statement OR the
 * session is unreachable (soft-fail so /fix degrades to "run the cell first"
 * rather than throwing). No mocks — hits the real Livy statements REST surface.
 */
export async function getLastLivyError(
  poolName: string,
  sessionId: number,
): Promise<{ ename?: string; evalue?: string; traceback?: string[] } | null> {
  let statements: LivyStatement[];
  try {
    statements = await listLivyStatements(poolName, sessionId);
  } catch {
    return null;
  }
  const errored = statements
    .filter((st) => st.state === 'available' && st.output?.status === 'error')
    .sort((a, b) => b.id - a.id);
  const last = errored[0];
  if (!last?.output) return null;
  const norm = normalizeLivyOutput(last.output);
  if (!norm || norm.status !== 'error') return null;
  return { ename: norm.ename, evalue: norm.evalue, traceback: norm.traceback };
}

/**
 * Fetch the last N statements of a live Livy session for the Notebook Copilot
 * /perf context. The persona embeds the normalized `textPlain` of these (which
 * carries Synapse's stage/row-count progress text + any skew warnings) into the
 * chat so the model can reason over REAL last-run telemetry rather than guess.
 *
 * Best-effort: returns [] (never throws to the caller) when the session has no
 * statements yet or the API is unreachable — the rest of the persona works
 * without telemetry. The default Spark-pool resolver mirrors mirror-engine.ts.
 */
export function defaultSparkPool(): string {
  return (
    process.env.LOOM_SYNAPSE_SPARK_POOL ||
    process.env.LOOM_SPARK_POOL ||
    process.env.LOOM_DEFAULT_SPARK_POOL ||
    'loompool'
  );
}

export async function getRecentStatements(
  poolName: string,
  sessionId: number,
  limit = 5,
): Promise<LivyStatement[]> {
  try {
    const r = await callDev(`${livyBase(poolName)}/sessions/${sessionId}/statements`);
    const j = await jsonOrThrow<{ total_statements?: number; statements?: LivyStatement[] }>(
      r,
      `getRecentStatements(${poolName}/${sessionId})`,
    );
    const stmts = Array.isArray(j.statements) ? j.statements : [];
    return stmts.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

// ============================================================
// Magic-command parsing (pure — no network; server + client safe)
// ============================================================

const MAGIC_KINDS: Record<string, MagicKind> = {
  '%%pyspark': 'pyspark',
  '%%python': 'pyspark',
  '%%spark': 'spark',
  '%%scala': 'spark',
  '%%sql': 'sql',
  '%%sparksql': 'sql',
  '%%sparkr': 'sparkr',
  '%%r': 'sparkr',
};

/**
 * Detect a leading Synapse language magic (%%pyspark / %%spark / %%sql /
 * %%sparkr and aliases) on the first non-empty line. Returns the resolved
 * statement `kind` plus the source with the magic line stripped (so Livy runs
 * the body, not the magic). Returns null when there is no language magic.
 */
export function parseMagicKind(source: string): { kind: MagicKind; strippedCode: string } | null {
  const lines = source.split('\n');
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { firstIdx = i; break; }
  }
  if (firstIdx < 0) return null;
  const first = lines[firstIdx].trim().toLowerCase();
  // Match the magic token (allow a trailing space + args, e.g. "%%sql -q").
  const token = first.split(/\s+/)[0];
  const kind = MAGIC_KINDS[token];
  if (!kind) return null;
  const stripped = [...lines.slice(0, firstIdx), ...lines.slice(firstIdx + 1)].join('\n');
  return { kind, strippedCode: stripped };
}

/**
 * Parse a `%%configure` magic cell. The JSON body after the magic line is
 * merged into the Livy session-create body. Per Synapse semantics %%configure
 * must be the first code cell and the session must be (re)created for it to
 * take effect. Returns the parsed session options, or null when the cell is not
 * a %%configure cell. Throws when the JSON body is malformed (surfaced to the
 * user — no silent swallow).
 */
export function parseConfigureMagic(source: string): Partial<LivySessionOptions> | null {
  const lines = source.split('\n');
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { firstIdx = i; break; }
  }
  if (firstIdx < 0) return null;
  const first = lines[firstIdx].trim().toLowerCase();
  if (!first.split(/\s+/)[0].startsWith('%%configure')) return null;
  const bodyText = lines.slice(firstIdx + 1).join('\n').trim();
  if (!bodyText) return {};
  let parsed: any;
  try { parsed = JSON.parse(bodyText); }
  catch (e: any) { throw new Error(`%%configure body is not valid JSON: ${e?.message || e}`); }
  if (parsed == null || typeof parsed !== 'object') return {};
  const opts: Partial<LivySessionOptions> = {};
  if (typeof parsed.driverMemory === 'string') opts.driverMemory = parsed.driverMemory;
  if (typeof parsed.driverCores === 'number') opts.driverCores = parsed.driverCores;
  if (typeof parsed.executorMemory === 'string') opts.executorMemory = parsed.executorMemory;
  if (typeof parsed.executorCores === 'number') opts.executorCores = parsed.executorCores;
  if (typeof parsed.numExecutors === 'number') opts.numExecutors = parsed.numExecutors;
  if (parsed.conf && typeof parsed.conf === 'object') {
    const conf: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.conf)) conf[k] = String(v);
    opts.conf = conf;
  }
  return opts;
}

// ============================================================
// Backend resolver
// ============================================================

/**
 * Azure-native default: Synapse Spark Livy. Databricks and the AML Compute-
 * Instance Jupyter kernel (`aml-ci`) are strictly opt-in via
 * LOOM_NOTEBOOK_BACKEND (per no-fabric-dependency.md the default path must never
 * require an opt-in backend). Any other value falls back to Synapse silently.
 */
export function resolveNotebookBackend(): 'synapse' | 'databricks' | 'aml-ci' {
  const v = (process.env.LOOM_NOTEBOOK_BACKEND || '').trim().toLowerCase();
  if (v === 'databricks') return 'databricks';
  if (v === 'aml-ci' || v === 'aml' || v === 'jupyter') return 'aml-ci';
  return 'synapse';
}

// ============================================================
// Output normalizer (server-side)
// ============================================================

function joinMaybeArray(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v.join('') : String(v);
}

const MAX_TABLE_ROWS = 200;

/**
 * Normalize a Livy statement output into the shape the editor renders:
 *   - text/plain  → textPlain
 *   - text/html   → textHtml (Synapse display(df) emits an HTML table here)
 *   - application/json with {schema:{fields},data} → tableColumns + tableRows
 *     (Vega-Lite / df json — the live rendered DataFrame grid)
 *   - image/png   → imageBase64 (matplotlib display output)
 *   - error       → ename/evalue/traceback
 */
export function normalizeLivyOutput(output: LivyStatementOutput | null | undefined): NormalizedOutput | null {
  if (!output) return null;
  if (output.status === 'error') {
    return {
      status: 'error',
      ename: output.ename,
      evalue: output.evalue,
      traceback: Array.isArray(output.traceback) ? output.traceback : undefined,
    };
  }
  const data = output.data || {};
  const norm: NormalizedOutput = { status: 'ok' };
  norm.textPlain = joinMaybeArray(data['text/plain']);
  const html = joinMaybeArray(data['text/html']);
  if (html) norm.textHtml = html;
  const png = data['image/png'];
  if (typeof png === 'string' && png) norm.imageBase64 = png;

  const appJson: any = data['application/json'];
  if (appJson && typeof appJson === 'object') {
    const fields = appJson?.schema?.fields;
    const rows = appJson?.data;
    if (Array.isArray(fields) && Array.isArray(rows)) {
      norm.tableColumns = fields.map((f: any) => String(f?.name ?? ''));
      norm.tableRows = rows.slice(0, MAX_TABLE_ROWS).map((row: any) => {
        if (Array.isArray(row)) return row.map((c: any) => (c == null ? '' : String(c)));
        // object rows keyed by column name
        return (norm.tableColumns || []).map((col) => {
          const c = row?.[col];
          return c == null ? '' : String(c);
        });
      });
    }
  }
  return norm;
}
