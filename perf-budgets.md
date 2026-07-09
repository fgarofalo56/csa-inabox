# `perf-budgets.json` — the PSR-2 regression-budget contract

> JSON carries no comments, so this file explains every number in `perf-budgets.json`.
> The perf gate (`scripts/csa-loom/perf/compare-baseline.mjs`, wired into
> `.github/workflows/perf-gate.yml`) reads the JSON, pulls the latest PSR-1 benchmark
> run + the trailing-N baseline from the `perf-benchmarks` Cosmos container, and fails
> the check when any budgeted metric breaches. See `docs/fiab/perf-gate.md`.

## How a budget is enforced

For each `(metric, backend)` row in the latest run, the metric **breaches** when EITHER:

1. **Absolute ceiling** — its `p95` exceeds `p95CeilingMs`. A hard floor on how slow a
   surface may ever get, grounded in the Fabric outcome-equivalence bar (see the PRP's
   §4 non-goals: we ship the *number*, not the *mechanism*). This catches a regression
   even on the very first run, when there is no baseline yet.
2. **Regression** — its `p95` is more than `maxRegressionPct` above the **median p95**
   of the trailing `trailingBaselineRuns` runs for the same metric+backend. This catches
   a slow creep that is still under the absolute ceiling.

A `fabricBarMs` (optional) is the published Microsoft Fabric latency for the same felt
outcome. It is **surfaced** in the gate table and on `/admin/performance`, never used to
fail the gate — it is the outcome-equivalence *target*, not a hard SLA. Where Loom
honestly trails Fabric by design (§1 of the PRP), the ceiling sits *above* the Fabric bar
and the table shows the honest gap.

## Justified regressions — `OVERRIDE_LABEL`

Set the CI env `OVERRIDE_LABEL="<reason>"` (e.g. a deliberate cold-start trade, or a
one-roll CI-infra-noise spike) to accept a breach for that roll. The breach is still
computed and printed in the receipt table (marked `⚠️ override`); the gate goes green
with the label attached — never a silent pass. Use it sparingly and document the reason
in the PR/roll.

## Top-level fields

| Field | Meaning |
|-------|---------|
| `version` | Schema version of this budget file. |
| `trailingBaselineRuns` | How many prior runs form the baseline window (median of their p95). 5 balances noise-smoothing against staleness. |
| `defaults.maxRegressionPct` | Regression budget applied when a metric omits its own `maxRegressionPct`. |
| `metrics.<name>.p95CeilingMs` | Absolute p95 ceiling in ms — latest p95 above this always breaches. |
| `metrics.<name>.maxRegressionPct` | Max allowed p95 regression vs the trailing baseline, in percent. |
| `metrics.<name>.fabricBarMs` | Optional Fabric outcome-equivalence reference (ms) — surfaced only. |

## Per-metric rationale

All ceilings are **honest, code-grounded** starting values (PRP §1 posture) — tighten
them as PSR-B speed closures land and measured baselines improve. They are the *floor*
we refuse to regress past, not a parity claim.

| Metric | Ceiling p95 | Max reg % | Fabric bar | Why this number |
|--------|------------:|----------:|-----------:|-----------------|
| `spark-attach-warm` | 15 s | 20% | ~10 s | Fabric starter pools pre-warm-attach in ~5–10 s ([Learn](https://learn.microsoft.com/en-us/fabric/data-engineering/configure-starter-pools)). With PSR-3's warm pool default-ON we target ≤15 s p95 on a warm hit; the warm-hit *goal* is ~3 s but the ceiling holds a hard line against the 2–4 min cold regression the pool exists to prevent. |
| `spark-attach-cold` | 20 s | 30% | ~10 s | A cold Synapse Livy miss (`spark-session-pool.ts` header: 2–4 min today) — PSR-3 target is <20 s. Wider regression budget because cold starts are inherently noisier. |
| `notebook-cell-roundtrip` | 8 s | 25% | — | Interactive cell execute round-trip on a warm session; keeps the notebook feeling live. |
| `warehouse-query` | 5 s | 25% | — | Synapse Serverless / dedicated-pool interactive query p95 (PSR-1 warehouse metric). |
| `adx-query` | 2 s | 20% | 2 s | RTI end-to-end is 2–30 s in Fabric; a single ADX `POST /v1/rest/query` tile should stay interactive at p95 ≤ 2 s (`kusto-client.ts`). PSR-6's results-cache pushes repeat queries well under this. |
| `dashboard-tile-tti` | 4 s | 25% | — | Time for a dashboard tile to first render data; PSR-7 parallelization + skeletons defend it. |
| `semantic-query-cached` | 1 s | 25% | 1 s | Direct Lake delivers sub-second repeat visuals ([Learn](https://learn.microsoft.com/en-us/fabric/fundamentals/direct-lake-overview)). PSR-5 targets the same *outcome* via the always-on result cache — sub-second on a cache hit. We never claim the Direct Lake mechanism (PRP §4). |
| `copilot-first-token` | 5 s | 25% | — | Streaming-first felt latency (PSR-8). The `LLM_FETCH_TIMEOUT_MS` 120 s ceiling is an abort deadline, not an SLO — this is the real first-token budget. |
| `copilot-full-turn` | 30 s | 25% | — | Full tool-loop turn; wide because agentic turns vary with tool count. |
| `page-tti` | 4 s | 20% | 4 s | Top-10-surface time-to-interactive (PSR-9). Heavy editors (report designer, notebook, MCP catalog) are defended by route-level code-splitting. |
| `silent-refresh` | 800 ms | 25% | — | The extra Cosmos round-trip every silent-refresh/OBO pays because Front Door affinity is OFF (`auth/msal.ts`); PSR-13 budgets it + adds an in-replica LRU. |
| `lake-read` | 3 s | 25% | — | ADLS Gen2 + Delta read p95 — the OneLake outcome-equivalent lake surface (PRP §4). |
| `lake-write` | 6 s | 25% | — | ADLS Gen2 + Delta write p95 (append/commit). |

## Changing a budget

- **Tightening** (lower ceiling / lower reg %) as a speed closure lands: do it in the same
  PR as the improvement, with the measured before/after in the PR body.
- **Loosening**: requires an explicit justification in the PR (an honest non-goal per
  `no-vaporware.md`) — a loosened ceiling that hides a real regression is a vaporware
  violation. Prefer an `OVERRIDE_LABEL` for a one-roll accepted regression over permanently
  relaxing the budget.
- **Adding a metric**: add its budget row here + a rationale line above once PSR-1 emits it.
  An unbudgeted metric is *surfaced* on `/admin/performance` but never gates the roll.
