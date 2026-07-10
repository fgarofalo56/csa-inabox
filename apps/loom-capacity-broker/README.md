# loom-capacity-broker — unified compute admission-control service (HYP-9)

Azure-native, stateful **admission-control** service that gives Loom a single
compute currency — the **LCU (Loom Capacity Unit)** — that **meters, smooths,
bursts, and throttles** across Synapse, Databricks, ADX, AML, and the two other
Loom Hyperscale services. It reproduces the *outcome* of a Microsoft Fabric
capacity (bursting ⊕ smoothing over 2,880 30-second timepoints ⊕ a four-stage
throttle) **without any Fabric dependency** — it never contacts
`api.fabric.microsoft.com` / `api.powerbi.com` (`.claude/rules/no-fabric-dependency.md`).

This is the **HYP-9/HYP-10 skeleton**: the `/admit` core path **EXECUTES
end-to-end** at skeleton stage (`.claude/rules/no-vaporware.md` — no stubbed
`/admit`, no mock frames). Choke-point wiring into the engine job-submit paths is
**HYP-11** and is intentionally **not** done here.

```
apps/loom-capacity-broker/
  go.mod                              # module loom-capacity-broker, go 1.23, ZERO external deps
  cmd/broker/main.go                  # HTTP server (net/http 1.22 method+path mux)
  internal/smoothing/                 # PURE smoothing math + golden test (PSR-1)
    smoothing.go
    smoothing_test.go
    testdata/smoothing_golden.json    # the golden file (1 CU-hr → 1.25 LCU/timepoint + throttle boundaries)
  internal/ledger/                    # 2,880 × 30s timepoint ledger
    ledger.go                         # interface + New() factory (redis when configured, else memory)
    memory_ledger.go                  # in-process fallback (DEFAULT — core path executes with no infra)
    redis_ledger.go                   # cross-replica backend over internal/resp
    *_test.go
  internal/resp/                      # tiny dependency-free RESP2 client (so build/test are OFFLINE)
    resp.go
    resp_test.go
  internal/broker/                    # smoothing ⊕ ledger ⊕ policy → admission decision
    broker.go
    broker_test.go
  Dockerfile                          # distroless static, non-root, internal ingress
```

## The smoothing model (grounded in Microsoft Learn)

Sources: `enterprise/throttling`,
`data-warehouse/compute-capacity-smoothing-throttling`,
`data-engineering/spark-job-concurrency-and-queueing`.

- Time is bucketed into **30-second timepoints**. An admitted job's LCU cost
  (expressed as **CU-seconds**) is **spread** across future timepoints per its
  class: **interactive over 5 min** (10 timepoints), **background over 24 h**
  (2,880 timepoints).
- Each timepoint offers `capacityCu × 30` CU-seconds of steady-state capacity
  (default F2-equivalent = 2 CU → 60 CU-seconds/timepoint).
- **Carry-forward** = how far into the future committed usage still outruns
  capacity. The **four-stage throttle** keys off it:

  | Carry-forward | Interactive | Background |
  |---|---|---|
  | `< 10 min` | allow (burst) | allow |
  | `10–60 min` | **delay 20s** | allow |
  | `60 min–24 h` | **reject** | allow |
  | `≥ 24 h` | reject | **reject** |

- Debt **self-heals**: as committed timepoints elapse they drop out of the
  window (memory prune / Redis `EXPIRE`), so throttling lifts automatically.

**Golden invariant** (`internal/smoothing/testdata/smoothing_golden.json`, the
PSR-1 "smoothing golden test"): a **1 CU-hour background job = 3,600 CU-seconds
spread over 2,880 timepoints = 1.25 LCU/timepoint**.

## Ledger backend — honest, reported per response

- **`LOOM_BROKER_REDIS` set** (alias `LOOM_CAPACITY_BROKER_REDIS`) → **redis**
  backend (Azure Cache for Redis Premium; `rediss://…:6380` or the
  StackExchange `host:6380,password=…,ssl=True` form both parse). Cross-replica
  coherent.
- **unset** → **memory** backend: a real in-process timepoint ledger so the core
  path executes with **no external dependency**. Single-replica (per-ACA-replica
  state) — the honest limitation, reported as `"backend":"memory"` on every
  response so the operator knows to set the Redis env for HA.

## API (internal HTTP; `external:false` ingress; port 8080)

| Method + path | Purpose |
|---|---|
| `GET /healthz` | liveness/readiness (`{ok,status,backend}`) |
| `POST /admit` | the hot path — `{ok, decision, delayMs?, reason, backend, carryForwardSeconds, …}` |
| `POST /report` | record actual post-run consumption |
| `GET /ledger/{tenant}/{workspace}?horizon=` | timepoint state for the admin UI (HYP-12) |
| `GET /policy?tenant=&workspace=` / `PUT /policy?…` | per-workspace policy (FGC-25 surge protection) |

### `POST /admit`
```jsonc
// request — requestedUnits (task) and estimatedLcu (PRP) are accepted aliases
{ "tenantId": "t1", "workspaceId": "w1", "engine": "spark", "requestedUnits": 30, "class": "background" }
// response (200)
{ "ok": true, "decision": "allow", "reason": "background job smooths over 24 h — admitted",
  "backend": "memory", "class": "background", "engine": "spark", "requestedLcu": 30,
  "perTimepointLcu": 0.0104, "carryForwardSeconds": 0, "lastHourLcu": 0, "timepoint": 57840 }
```
`decision` is one of `allow | delay | reject` (the PRP-canonical values;
the task's `admit | queue | reject` are exact synonyms). `allow`/`delay` commit
the smoothed spread to the ledger; `reject` never consumes.

## Build (server-side ACR Tasks — no local Docker)

```bash
az acr build -r <acr> -t loom-capacity-broker:<tag> apps/loom-capacity-broker
```

## Test

```bash
go test ./...        # offline — zero external modules; golden + ledger + resp + broker
go vet ./...
```

> **Local-build limitation (honest):** this worktree's CI host has **no Go
> toolchain**, so `go build` / `go test` were **not run locally** during
> authoring. The service is **dependency-free** (stdlib only), so CI and
> `az acr build` build and test it with no module download. The pure logic
> (smoothing math, RESP codec, in-memory ledger, admission decisions, conn-string
> parsing) is covered by table/golden tests that run offline.

## HONEST LIMITS (per PRP §7.10)

- **LCU is a coefficient model, not a metered CU.** Loom's LCU is a *published
  coefficient* over engine-native meters (vCore-s, DBU-s, ADX cost, tokens) — see
  `apps/fiab-console/lib/azure/cost-attribution.ts` `ATTRIBUTION_RATES`. It is
  transparent and tunable but is an approximation; chargeback stays reconciled
  against real Azure Cost Management `$`-truth.
- **Bursting is bounded by each engine's own elasticity.** The broker *gates and
  accounts for* burst; it cannot grant burst an engine can't physically provide.
- **Not cross-tenant hyperscale.** Per tenant/workspace on the customer's own
  compute — no global rescue-capacity pool.
- **Admission is advisory-strong.** It governs Loom-mediated submission at the
  choke-points Loom controls (wired in HYP-11), not raw ARM/SDK calls.
- **Perf tuning is deferred.** The Redis path pipelines an admit's spread in one
  round trip, but `HGETALL` on the future-window read is O(hash-size); the p99 ≤
  10 ms PSR-1 target is met on memory and is a tuning item (HMGET/Lua) for the
  Redis path.

## Rules honored

- **no-vaporware** — real admission math, real ledger (memory + redis), real HTTP
  server; honest `"backend"` reporting + honest-503 console gate + bicep-sync.
- **no-fabric-dependency** — Azure-native only; no Fabric/Power BI host ever contacted.
- **bicep-sync** — `platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep`
  (`minReplicas: 2`) ships in the same change set; `LOOM_CAPACITY_BROKER_URL`
  wiring documented in that module's doc block.
