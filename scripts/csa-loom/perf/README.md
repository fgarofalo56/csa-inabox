# CSA Loom performance benchmark harness (PSR-1)

A repeatable performance suite that measures the numbers users feel, persists
them to Cosmos, and trends them across rolls — so every other performance item
has an objective acceptance. See `PRPs/active/next-waves/PRP-performance-scale-parity.md` §PSR-1.

Every metric drives a **real Azure-native backend**. No Microsoft Fabric
endpoint is ever called (`.claude/rules/no-fabric-dependency.md`); an
unconfigured backend records an **honest gate row** naming the exact env var,
never a fabricated number (`.claude/rules/no-vaporware.md`).

## What it measures

| Metric | Backend (Azure-native) | Fabric bar (outcome-equivalence target) |
|---|---|---|
| `spark-attach` | Azure Synapse Livy (opt-in, billed) | starter pool ~5-10s |
| `notebook-roundtrip` | Azure Synapse Livy (opt-in, billed) | interactive cell ~2s |
| `warehouse-query-serverless` | Synapse serverless (on-demand) SQL | Direct Lake sub-second |
| `warehouse-query-dedicated` | Synapse dedicated SQL pool | Direct Lake sub-second |
| `adx-query` | Azure Data Explorer (Kusto) | RTI 2-30s |
| `dashboard-tile-tti` | Azure Data Explorer (tile aggregation) | Real-Time dashboard tile ~3s |
| `copilot-turn` | Azure OpenAI (first-token + full-turn) | Copilot full turn ~3s |
| `page-tti:<surface>` | Console HTML GET (top-10 surfaces) | portal nav ~2s |

## Run it

```bash
SESSION_SECRET=<container-app session-secret / KV loom-session-secret> \
UAT_OID=<a tenant-admin OID> \
node scripts/csa-loom/perf/run-benchmark.mjs --samples 6 [--include-spark] [--out run.json]
```

The script:

1. Mints a session cookie (same probe as `apps/fiab-console/e2e/_lib/uat.ts`).
2. Measures **page TTI** for the top-10 surfaces directly over authenticated HTTP.
3. Triggers the **server-side** engine suite via `POST /api/admin/performance/run`
   (the console drives Synapse / ADX / AOAI where the credentials live), polls
   `GET /api/admin/performance/run?runId=…` until it finishes, and pulls the
   persisted metric docs back.
4. Writes a run document (`test-results/perf/run-<ts>.json` by default) and
   prints a compact `p50 / p95 / fabric-bar` table for the roll receipt.

`UAT_OID` **must be a tenant admin** — the `/api/admin/performance/*` routes are
`requireTenantAdmin`-gated (org-wide perf posture).

## Where the data lives

* **Cosmos `perf-benchmarks`** (created lazily by the console) — the
  authoritative trend store the `/admin/performance` page reads. Doc shape:
  `{runId, gitSha, rev, metric, backend, p50, p95, p99, coldMs, warmMs, ts, …}`.
* **Optional `LoomPerf_CL`** Log Analytics table — deploy
  `platform/fiab/bicep/modules/admin-plane/perf-benchmarks-dcr.bicep`, then set
  `LOOM_PERF_DCR_ENDPOINT` + `LOOM_PERF_DCR_ID` on the console app to also stream
  rows into KQL. Strictly additive; the exporter is a silent no-op until wired.

## In-product

The same suite is available in the console at **Admin → Performance & benchmarks**
(`/admin/performance`): per-metric trend charts with the Fabric reference line and
a tenant-admin-gated **Run benchmark now** button.
