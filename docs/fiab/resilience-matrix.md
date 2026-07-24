# Resilience matrix — dependency-fault coverage (CH1)

**Owner:** loom-next-level CH1 · **Enforced by:** `scripts/ci/check-breaker-coverage.mjs`
(unbounded-`fetch()` ratchet) + `apps/fiab-console/lib/resilience/breaker-audit.ts`
(the typed inventory this doc renders) · **Drill surface:** `/admin/health?tab=chaos`

CSA Loom wires resilience piecemeal across the transport layer — this doc is the
single inventory of **which `lib/azure` client retries, backs off, breaks,
serve-stales, or honest-gates** on the four first-class dependency faults
(Cosmos 429, Azure OpenAI 429/timeout, ADX cold-start, Key Vault throttle), plus
the shared caching/Spark layers those faults flow through.

A13's chaos harness is **Spark-only** (kill Livy sessions / arm a pool's FAULTED
breaker). CH1 extends fault *injection* to the dependency plane so each row below
is **provable**, not asserted: arm a fault on the Dependency chaos tab and watch
the surface degrade to serve-stale / an honest gate — never a crash or a dark
render.

> Cross-reference: `PRPs/active/enterprise-hardening/appendix-ops-slo-loadtest.md`
> owns admission-control / rate-limiting + the AOAI-429 **retry** spec. CH1 is
> fault-**injection proof** — it cites those mechanisms, it does not duplicate them.

## The matrix

| Fault point | Dependency | Source file | Timeout | Retry / failover | Breaker | Serve-stale | Honest gate | Degrades to |
|---|---|---|:-:|:-:|:-:|:-:|:-:|---|
| `cosmos-429` | Azure Cosmos DB | `lib/azure/cosmos-client.ts` | ✅ | ✅ | — | ✅ | ✅ | getOrComputeCached `serveStaleOnError` serves the last-good copy + a stale banner; a non-cached read surfaces an honest structured error. |
| `aoai-429` | Azure OpenAI | `lib/azure/aoai-chat-client.ts` | ✅ | ✅ | — | — | ✅ | 429 → `AoaiResponseError`; the Copilot dock shows a rate-limit message. |
| `aoai-timeout` | Azure OpenAI | `lib/azure/fetch-with-timeout.ts` | ✅ | ✅ | — | — | ✅ | Hung inference trips `LLM_FETCH_TIMEOUT_MS` → `FetchTimeoutError`; the worker is never pinned. |
| `adx-cold` | Azure Data Explorer | `lib/azure/kusto-client.ts` | ✅ | — | — | ✅ | ✅ | 503 → honest `KustoError`; `executeQueryCached` serves a cached copy when one exists. |
| `kv-throttle` | Azure Key Vault | `lib/azure/kv-secrets-client.ts` | ✅ | — | — | — | ✅ | 429 → `KeyVaultError` carrying the status; an honest remediation, not a crash. |
| — | Query result cache (serve-stale tier) | `lib/azure/query-result-cache.ts` | ✅ | ✅ | — | ✅ | ✅ | The primary Cosmos/ADX degradation path — serves the expired copy + one background recompute. |
| — | Redis cache (circuit breaker) | `lib/azure/redis-cache-client.ts` | ✅ | — | ✅ | — | ✅ | After 3 consecutive failures the breaker OPENs; Redis is skipped for the reset window. |
| — | Synapse Spark warm pool (A13 breaker) | `lib/azure/spark-session-pool.ts` | ✅ | ✅ | ✅ | — | ✅ | A FAULTED / can't-launch pool arms the warm-pool breaker → A11 auto-recovers (delete + recreate). |

Legend: ✅ present · — not applicable / not present for this class.

## Known gaps (fault rows without serve-stale AND without a breaker)

`aoai-429`, `aoai-timeout`, and `kv-throttle` degrade to an **honest gate**
(timeout + honest error) rather than serving a stale copy — correct for those
classes (there is no meaningful "last-good" LLM answer or secret to serve). The
`auditBreakerCoverage()` summary counts these under
`faultRowsWithoutStaleOrBreaker`; they are intentional, not gaps to close.

## The enforcement floor

The one machine-enforced invariant beneath this inventory:
**every `lib/azure` client makes its network round-trips through the bounded
transport (`fetchWithTimeout()` / `withDeadline()`), never a raw unbounded
`fetch()`.** `check-breaker-coverage.mjs` ratchets the raw-`fetch(` count in
`lib/azure` down (baseline: **0** — every client is already bounded) and fails a
PR that adds a new unbounded call.

## Running a drill

1. **Non-prod only.** Set `LOOM_DEPENDENCY_CHAOS_ENABLED=true` on the Console app
   (it MUST stay unset in production — with it unset the injection code path is
   provably dead).
2. Enable the **`ch1-dependency-chaos`** runtime flag (Admin → Runtime flags) —
   deliberately opt-in, default OFF.
3. Open **`/admin/health?tab=chaos`**, pick a fault, set a TTL, and **Arm**
   (the POST additionally requires a valid `LOOM_INTERNAL_TOKEN`).
4. Exercise the target surface (e.g. a cost fan-out for `cosmos-429`, a Copilot
   turn for `aoai-429`, an RTI query for `adx-cold`). Confirm it serves stale /
   shows an honest banner — **no 5xx, no dark render**.
5. Every arm/disarm and every injection is audited (`chaos.fault.*`); armed
   faults auto-expire (≤5 min) so a forgotten drill self-heals.

## Per-cloud

Commercial + Gov run the live drill (in-process injection at the Console's own
transport chokepoints — no Azure permission is exercised by arming). IL5:
design-only, in-boundary — enable for a scheduled non-prod drill exactly as
above; nothing leaves the enclave.
