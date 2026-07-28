/**
 * breaker-audit — the CH1 circuit-breaker / resilience inventory across
 * `lib/azure/*`.
 *
 * Resilience in the Console was wired piecemeal: `fetch-with-timeout.ts` gives
 * every server round-trip a per-request deadline; `query-result-cache.ts`'s
 * `getOrComputeCached({ serveStaleOnError })` serves the last-good copy when a
 * backend throws; `redis-cache-client.ts` runs a real 3-fail circuit breaker;
 * `aoai-chat-client.ts` falls back APIM→direct; `spark-session-pool.ts` arms a
 * warm-pool breaker. This module is the single, typed INVENTORY of those
 * mechanisms for the four dependency-fault classes CH1's harness injects
 * (Cosmos, AOAI, ADX, KV) plus the shared caching/Spark layers — the data
 * behind `docs/fiab/resilience-matrix.md` and the admin chaos tab's
 * "Resilience matrix" view.
 *
 * It is descriptive, not executable: each row names the real source file + the
 * mechanisms that file (or the layer it flows through) uses, so a reviewer can
 * click straight to the guarantee. The `check-breaker-coverage.mjs` ratchet is
 * the ENFORCEMENT half — it fails a PR that adds a new unbounded (timeout-less)
 * `fetch()` to a `lib/azure` client, keeping the "every client is bounded"
 * floor this inventory documents.
 *
 * Cross-reference: enterprise-hardening owns the admission-control / rate-limit
 * / AOAI 429-RETRY specs; CH1 is fault-INJECTION proof — this inventory cites
 * the mechanisms, it does not re-implement retry.
 */

/** The resilience mechanisms a client (or its layer) provides. */
export interface ResilienceMechanisms {
  /** Bounded per-request deadline (fetchWithTimeout / withDeadline / AbortController). */
  timeout: boolean;
  /** Retries or fails over on a transient error (SDK retry, APIM→direct, sampling-param retry). */
  retry: boolean;
  /** A circuit breaker that opens after consecutive failures. */
  breaker: boolean;
  /** Serves a stale/last-good copy when the live call throws (serveStaleOnError / cache tier). */
  serveStale: boolean;
  /** Degrades to an honest, structured gate/error (never a dark render / unhandled 5xx). */
  honestGate: boolean;
}

/** One inventory row: a dependency client + its resilience posture. */
export interface ResilienceRow {
  /** The CH1 fault point this client is exercised by, or null for a shared layer. */
  faultPoint: 'cosmos-429' | 'aoai-429' | 'aoai-timeout' | 'adx-cold' | 'kv-throttle' | null;
  dependency: string;
  /** Repo-relative source file (the ratchet reads these to know what is classified). */
  sourceFile: string;
  mechanisms: ResilienceMechanisms;
  /** How this client degrades under the injected fault — the observable proof. */
  degradesTo: string;
}

const T = (
  timeout: boolean,
  retry: boolean,
  breaker: boolean,
  serveStale: boolean,
  honestGate: boolean,
): ResilienceMechanisms => ({ timeout, retry, breaker, serveStale, honestGate });

/**
 * The resilience matrix. Grounded in the real source: each row's mechanisms are
 * verifiable in `sourceFile` (or the shared layer it flows through).
 */
export const RESILIENCE_MATRIX: readonly ResilienceRow[] = [
  {
    faultPoint: 'cosmos-429',
    dependency: 'Azure Cosmos DB',
    sourceFile: 'apps/fiab-console/lib/azure/cosmos-client.ts',
    // SDK built-in 429 retry; probe bounded by AbortController; hot reads flow
    // through getOrComputeCached whose serveStaleOnError serves last-good.
    mechanisms: T(true, true, false, true, true),
    degradesTo:
      'A getOrComputeCached surface with serveStaleOnError serves the last-good copy + a stale banner; a non-cached read surfaces an honest structured error (never a 5xx dark render).',
  },
  {
    faultPoint: 'aoai-429',
    dependency: 'Azure OpenAI',
    sourceFile: 'apps/fiab-console/lib/azure/aoai-chat-client.ts',
    // LLM fetch deadline; sampling-param retry + APIM→direct fallback; token-budget honest 429.
    mechanisms: T(true, true, false, false, true),
    degradesTo:
      'The 429 is surfaced as an AoaiResponseError → the Copilot dock shows a rate-limit message; no dark render.',
  },
  {
    faultPoint: 'aoai-timeout',
    dependency: 'Azure OpenAI',
    sourceFile: 'apps/fiab-console/lib/azure/fetch-with-timeout.ts',
    // LLM_FETCH_TIMEOUT_MS bounds inference; FetchTimeoutError is distinguishable.
    mechanisms: T(true, true, false, false, true),
    degradesTo:
      'A hung inference call trips LLM_FETCH_TIMEOUT_MS → FetchTimeoutError instead of pinning the worker; the caller shows an honest "backend timed out" state.',
  },
  {
    faultPoint: 'adx-cold',
    dependency: 'Azure Data Explorer (Kusto)',
    sourceFile: 'apps/fiab-console/lib/azure/kusto-client.ts',
    // fetchWithTimeout on postRest; executeQueryCached fronts reads with the tiered cache.
    mechanisms: T(true, false, false, true, true),
    degradesTo:
      'A 503 cold-start surfaces an honest KustoError; executeQueryCached serves a cached copy when one exists rather than crashing the RTI surface.',
  },
  {
    faultPoint: 'kv-throttle',
    dependency: 'Azure Key Vault',
    sourceFile: 'apps/fiab-console/lib/azure/kv-secrets-client.ts',
    // fetchWithTimeout on every secret round-trip; kvSecretsConfigGate honest gate.
    mechanisms: T(true, false, false, false, true),
    degradesTo:
      'A 429 surfaces a KeyVaultError carrying the status; the calling surface shows an honest remediation, not an unhandled crash.',
  },
  // ── Shared resilience layers the fault classes flow through ──
  {
    faultPoint: null,
    dependency: 'Query result cache (serve-stale-on-error tier)',
    sourceFile: 'apps/fiab-console/lib/azure/query-result-cache.ts',
    mechanisms: T(true, true, false, true, true),
    degradesTo:
      'getOrComputeCached({ serveStaleOnError }) serves the most-recent expired copy + kicks one background recompute when the live compute throws — the primary Cosmos/ADX degradation path.',
  },
  {
    faultPoint: null,
    dependency: 'Redis cache (circuit breaker)',
    sourceFile: 'apps/fiab-console/lib/azure/redis-cache-client.ts',
    mechanisms: T(true, false, true, false, true),
    degradesTo:
      'After 3 consecutive failures the breaker OPENs and Redis is skipped entirely for the reset window — the cache degrades to its next tier, never blocking a request.',
  },
  {
    faultPoint: null,
    dependency: 'Synapse Spark warm pool (A13 breaker)',
    sourceFile: 'apps/fiab-console/lib/azure/spark-session-pool.ts',
    mechanisms: T(true, true, true, false, true),
    degradesTo:
      'A FAULTED / "Succeeded-but-can\'t-launch" pool arms the warm-pool breaker (classifies "suspect"); the A11 keep-warm tick auto-recovers it (delete + recreate). This is A13\'s Spark-only chaos, extended here to the dependency plane.',
  },
];

/** Aggregate coverage over the matrix (admin overview + the audit summary). */
export interface BreakerCoverageSummary {
  totalRows: number;
  faultRows: number;
  withTimeout: number;
  withRetry: number;
  withBreaker: number;
  withServeStale: number;
  withHonestGate: number;
  /** Fault-point rows with NEITHER serve-stale NOR a breaker (retry/timeout/gate only). */
  faultRowsWithoutStaleOrBreaker: number;
}

/** Compute the coverage summary. Pure. */
export function auditBreakerCoverage(rows: readonly ResilienceRow[] = RESILIENCE_MATRIX): BreakerCoverageSummary {
  const faultRows = rows.filter((r) => r.faultPoint !== null);
  return {
    totalRows: rows.length,
    faultRows: faultRows.length,
    withTimeout: rows.filter((r) => r.mechanisms.timeout).length,
    withRetry: rows.filter((r) => r.mechanisms.retry).length,
    withBreaker: rows.filter((r) => r.mechanisms.breaker).length,
    withServeStale: rows.filter((r) => r.mechanisms.serveStale).length,
    withHonestGate: rows.filter((r) => r.mechanisms.honestGate).length,
    faultRowsWithoutStaleOrBreaker: faultRows.filter((r) => !r.mechanisms.serveStale && !r.mechanisms.breaker).length,
  };
}
