# Performance & benchmarks admin page

> **Surface:** `/admin/performance`
> **BFF:** `apps/fiab-console/app/api/admin/performance/{run,cache-stats,copilot-slo}/route.ts`
> **Store:** Cosmos `perf-benchmarks` (PK `/runId`) — trend history retained across rolls

The **Performance & benchmarks** page runs the repeatable PSR-1 performance suite
on demand and trends the results against the published Microsoft Fabric bars, so
an operator can prove — with real numbers, not claims — that Loom meets or beats
the Fabric-grade floor.

Each run measures **p50 / p95 / p99** plus **cold-vs-warm** latency for the
Loom-critical paths: Spark session attach, warehouse / ADX query, dashboard tile
time-to-interactive, a Copilot turn (first token + full turn), and page TTI. All
backends are Azure-native and the run executes against the live deployment — no
synthetic timings.

## What you can do

- **Run the suite** — `POST /api/admin/performance/run` executes the probes and
  writes one `perf-benchmarks` row per (runId, metric); the trend chart plots
  successive runs.
- **Compare to Fabric** — each metric is annotated with the published Fabric bar
  so regressions and wins are obvious.
- **Cache stats** — `/api/admin/performance/cache-stats` surfaces the query /
  result-cache hit-rate feeding the warehouse & ADX paths.
- **Copilot SLO** — `/api/admin/performance/copilot-slo` shows the Copilot turn
  latency budget (first-token + full-turn) and whether the current window is in
  budget.

## Backend

| Control | Backend |
|---|---|
| Benchmark run | `lib/perf/*` probes against the live Azure backends |
| Trend history | Cosmos `perf-benchmarks` (PK `/runId`, no TTL) |
| CI regression gate | `.github/workflows/perf-gate.yml` + `perf-budgets.json` |
| Optional export | `LoomPerf_CL` Log Analytics DCR (honest-gated; off until `LOOM_PERF_DCR_*` set) |

## RBAC & honest gates

Runs as the Console UAMI with **Monitoring Reader**. When a probed backend isn't
provisioned the metric shows an honest gate rather than a zero; the optional Log
Analytics export stays a silent no-op until its DCR env vars are present.

## Related

- [Capacity & compute](capacity.md) · [Scale by SKU](scaling.md)
