# Dependency-chaos harness

> **Surface:** `/admin/health?tab=chaos` — the **Dependency chaos** tab on the Health and Reliability hub
> **Backend:** `GET` / `POST /api/admin/chaos/dependency` mutating the live in-process fault registry that the Cosmos client and the shared fetch chokepoints consult
> **Kill-switch flag:** `ch1-dependency-chaos` — **default OFF**. Chaos is operator-initiated, so this is the second documented exception to Loom's default-on rule.
> **Honest gate:** `LOOM_DEPENDENCY_CHAOS_ENABLED` (unset or `false` is the intended production posture) plus a valid `LOOM_INTERNAL_TOKEN`

A resilience-drill tool. Arm a real fault against **this replica** — a Cosmos
429, an Azure OpenAI 429 or timeout, an ADX cold start, a Key Vault throttle —
and prove that the surface above it degrades to serve-stale or an honest gate
rather than crashing or rendering dark.

**Operator runbook, not an end-user feature.** Run it in a non-production
deployment.

## Why it exists

The resilience matrix claimed the estate degrades gracefully. Claims are not
evidence. Every dependency has a documented resilience path — serve-stale
caching, the Azure OpenAI fallback chain, honest client errors, fetch deadlines —
and the only way to prove those paths work is to make the dependency fail on
purpose and watch the surface.

## The five fault points

| Fault | Dependency | What arming it proves |
|---|---|---|
| `cosmos-429` | Azure Cosmos DB | Every Cosmos read gates on `ensure()`; an injected 429 forces reads to throw, so a serve-stale-on-error surface serves the last-good copy with an honest banner instead of a 5xx. |
| `aoai-429` | Azure OpenAI | A 429 from the model endpoint surfaces as an honest response error — the Copilot dock shows a rate-limit message, never a dark render. |
| `aoai-timeout` | Azure OpenAI | A hung inference call trips the LLM fetch deadline instead of pinning the worker; the caller degrades gracefully. |
| `adx-cold` | Azure Data Explorer | A cold cluster returns 503; the Kusto client surfaces an honest error and the cached query path degrades rather than crashing the Real-Time Intelligence surface. |
| `kv-throttle` | Azure Key Vault | A throttled Key Vault returns 429; the client surfaces an honest error with the status, not an unhandled crash. |

## How to run a drill end to end

**Prerequisites (all four, in a non-production deployment):**

1. A **tenant-admin** session.
2. The `ch1-dependency-chaos` runtime flag turned **ON** (it defaults OFF).
3. `LOOM_DEPENDENCY_CHAOS_ENABLED=true` on the Console app. With it unset the
   injection code path is **provably dead** — this is the hard production gate.
4. A valid `LOOM_INTERNAL_TOKEN` presented on the request (Bearer or the
   `x-loom-internal-token` header) — the same machine-trust secret the Spark
   chaos drill requires.

**Then:**

1. Open **Admin → Health → Dependency chaos**. The tab shows the resilience
   matrix, the fault points, whatever is currently armed on this replica, and
   whether the harness is armable in this deployment.
2. **Arm a fault.** Choose the point, optionally a TTL and an occurrence budget,
   and a reason. The TTL is capped at **five minutes** and the occurrence budget
   at 1,000, so a **forgotten drill self-heals**.
3. **Exercise the surface** that depends on it and confirm the expected
   degradation from the table above — a stale-serve banner, an honest gate, a
   rate-limit message. A crash, a blank pane, or a silently-zero count is a
   defect, and finding it is the point of the drill.
4. **Disarm** the single fault, or use disarm-all.
5. **Read the audit.** Every arm, disarm and injection is audited, and the tab
   keeps a ring of the most recent injections per fault so you can reconstruct
   what happened.

## What the backend actually does

`GET /api/admin/chaos/dependency` returns whether the harness is enabled, the
flag state, whether it is armable here, the fault points, what is currently
armed, the resilience matrix and coverage. `POST` takes `arm`, `disarm` or
`disarm-all`.

Arming mutates the **real in-process fault registry** that the live Cosmos client
and the shared timeout-aware fetch consult. Nothing is simulated at the UI
layer — the dependency genuinely fails for the armed replica.

Because the registry is in-process, a fault applies to **one replica**. That is
deliberate: a drill should not take the estate down.

## Honest gates

When the harness is not armable — typically `LOOM_DEPENDENCY_CHAOS_ENABLED`
unset, which is the correct production posture — **the tab still renders in
full**: the resilience matrix plus an honest message bar naming the exact
environment variable and the internal token required. It is never a blank pane,
and the arm controls are simply refused server-side.

## Kill-switch

`ch1-dependency-chaos` — **default OFF**, read with an explicit false default.
Turning it ON only *reveals the tab*; arming still requires the other three
gates. Turning it OFF hides the tab and the arming route rejects — the
seconds-fast kill switch for the whole harness.

## Related

- [Resilience matrix](../resilience-matrix.md) — the claims this harness verifies
- [Health and self-audit](../admin/health.md)
- [Monitoring and observability](../operations/monitoring.md)
- [Disaster recovery](../operations/disaster-recovery.md)
