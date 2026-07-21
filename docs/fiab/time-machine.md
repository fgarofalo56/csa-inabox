# Time-Machine (WS-10.3 / BTB-10) — one `asOf` across every backend

**Status:** coordinator + ontology as-of shipped and unit-tested; report/pipeline
as-of honest-gated pending the browser-E2E receipt (Track-0 owed).

Time-Machine lets you view the whole platform **as of a point in time T** —
the ontology, reports, and pipeline output — by threading a single `asOf`
selector through every query path. A temporal **coordinator** turns that one
selector into each Azure-native backend's **native** time-travel clause. No
Fabric, no OneLake — Gov-safe (`no-fabric-dependency.md`).

## The one selector

`AsOfSpec` (in `lib/time-machine/time-machine.ts`):

- `{ kind: 'live' }` — current state (default; every query is byte-identical).
- `{ kind: 'timestamp', iso }` — wall-clock ("as of 2026-07-01T17:00Z").
- `{ kind: 'version', version }` — a Delta commit version (exact reproducibility).

`parseAsOf()` accepts an ISO instant, a bare date (→ UTC midnight), or `v:<n>` /
`version=<n>`; it throws on malformed input so routes return a precise 400 rather
than silently reading live data. Wire form: `serializeAsOf()` / `withAsOfParam()`.

## Per-backend native resolution (`resolveTimeTravel(backend, spec)`)

| Backend | Native clause | Grounding |
|---|---|---|
| `delta` (Databricks SQL / Spark SQL over Delta) | `… FROM t TIMESTAMP AS OF '<iso>'` / `VERSION AS OF <n>` | Delta history |
| `adx` (Azure Data Explorer) | `T \| where ingestion_time() <= datetime(<iso>)` | ADX ingestion-time |
| `synapse-temporal` (Dedicated SQL system-versioned) | `… FROM t FOR SYSTEM_TIME AS OF '<iso>'` | SQL temporal tables |
| `synapse-serverless-delta` | **honest gate** — Serverless reads the current snapshot; no inline time-travel | — |
| `dax` (semantic layer) | **honest gate** — no native time-travel; inherits its source's as-of | — |

Backends without inline time-travel return a structured gate naming the as-of
capable path — never live rows dressed up as "as of T" (`no-vaporware.md`).

## Threading

- **Ontology** (`GET /api/items/ontology/[id]/resolve?objectType=…&asOf=…`) —
  each bound source maps its kind → backend (`backendForOntologySourceKind`) and
  the coordinator's clause is threaded into the query builders
  (`buildSqlSelect` / `buildKql`). A KQL/ADX source and a Synapse-temporal
  warehouse resolve **real** time-traveled rows; a Serverless-Delta / DAX source
  honest-gates in `sources[].gate`.
- **Report** (`POST /api/items/report/[id]/query`) — a non-live `asOf` is honest-
  gated (412 `time_travel_report`) naming the as-of path (the report's Delta/
  lakehouse source, or the Databricks SQL accel engine) until the in-report Delta
  AS OF accel path is E2E-verified.
- **Pipeline output** — served through the same coordinator via the pipeline's
  sink lakehouse/warehouse binding (query the sink table as of T).

## Branch = shadow workspace

A **time-branch** (`lib/time-machine/time-branch-store.ts`, Cosmos container
`time-branches`, PK `/workspaceId`) is a named, zero-copy pin to an `asOf` over a
workspace — the sovereign analogue of a git branch for data. Selecting one in the
global time-bar sets the session `asOf`; every surface then reads as of the
branch's T. Routes: `GET|POST /api/workspaces/[id]/time-branches`,
`DELETE …/[branchId]` (workspace-authorized).

## Global time-bar

`lib/components/time-machine/global-time-bar.tsx` in the app-shell topbar. Sets
the session `asOf` in the UI store (`useUi(s => s.asOf)`), persisted across
navigation. Live / specific-instant / Delta-version picker + the workspace's
time-branches (open, save-current, delete). Fluent v9 + Loom tokens.

## Owed (Track-0)

Browser-E2E receipt: query ontology + report + pipeline output as of T against a
live deployment (ADX/warehouse-temporal real path + report accel Delta AS OF).
