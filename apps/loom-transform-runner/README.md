# CSA Loom — transform runner (N4)

Dual-engine transformation runtime for the Loom **`transformation-project`**
item. One Container App, two engines, one project model:

| Engine | Why it is here | Default? |
|---|---|---|
| **dbt-core** | Keeps the whole dbt ecosystem — adapters, packages, tests, docs, and the `target/manifest.json` the Console's L6 lineage parser already consumes. | **Yes** (`backend: "dbt"` — continuity) |
| **SQLMesh** | Adds what dbt does not have: **virtual data environments** (an env is a view swap, not a rebuild), **Terraform-style plan/apply** with BREAKING / NON-BREAKING categorization, and **column-level model diff**. | Opt-in (`backend: "sqlmesh"`) |

Neither engine is removed for the other. The Console's
`transformation-project` item carries a backend selector that defaults to
`dbt`; switching to `sqlmesh` re-plans the SAME model set.

## API

- `GET /health` → `{ "ok": true }`
- `GET /capabilities` → the engines + dbt adapters actually installed in the image
- `POST /plan` → impact preview, **writes nothing**
  ```json
  { "backend": "sqlmesh", "environment": "dev",
    "files": [{ "path": "config.yaml", "content": "…" }] }
  ```
  SQLMesh returns `plan.changes[]` with the real `SnapshotChangeCategory`
  (`breaking` / `non_breaking` / `forward_only` / `indirect_*` / `metadata`),
  the indirectly-modified downstream set, both column→type maps, and the
  missing intervals that would be backfilled.
  dbt returns the **real state comparison**: compile the project, diff the fresh
  `target/manifest.json` against the deployed-state manifest supplied as
  `previousManifest` (the `dbt ls --select state:modified` mechanism), plus the
  column maps from `catalog.json` and the manifest `child_map` downstream.
- `POST /apply` → SQLMesh: build **and** apply (virtual-environment view swap +
  backfill). dbt: `dbt deps` + `dbt build` (dbt has no view-swap apply).
- `POST /run` → SQLMesh `run` (scheduled cadence) / dbt command list.
- `POST /environments` → the real environments in the SQLMesh state store. For
  dbt it honestly returns `[]` plus a note — dbt has no virtual environments.
- `POST /diff` → SQLMesh `table_diff` between two environments of one model:
  columns added / removed / type-changed plus row counts when keys exist.

Every response is `{ ok, exitCode, log, … }`. On an engine exception the real
message is returned verbatim (`ok:false`) — the runner never fabricates a plan.

## Auth + security

- **User-assigned managed identity only.** `AZURE_CLIENT_ID` is injected by
  bicep; dbt-synapse / dbt-fabric / SQLMesh's mssql adapter authenticate through
  ODBC Driver 18 with the container identity. **No passwords, no storage account
  keys, no secrets in app settings.**
- **Internal ingress only** — reachable from the Console over the Container Apps
  VNet at `LOOM_TRANSFORM_RUNNER_URL`.
- dbt commands are validated against an allow-list (`ALLOWED_DBT_COMMANDS`); the
  Console builds them from checkboxes, so no freeform command string reaches the
  runtime.
- Project files are written with a path-traversal guard into a per-request temp
  directory that is destroyed when the request ends.

## SQLMesh state

SQLMesh's state store lives in the **target engine itself** (a `sqlmesh_state`
schema on the Synapse pool / Databricks catalog / DuckDB file). There is no
extra Azure resource, no external service, and no SaaS control plane.

## Cost

Min-1 replica (0.75 vCPU / 1.5 GiB) so `plan` is interactive rather than paying
a cold start on every keystroke of the wizard: **≈ $100–200 / month / cloud**.
Max 4 replicas with an HTTP concurrency rule for parallel plans.

## Sovereignty (IL5 / air-gapped)

Both engines are OSS Python running **inside the deployment's own VNet** on
Azure Container Apps, against **customer-owned** Synapse / Databricks / ADLS
(DuckDB over ADLS for the fully-disconnected case). There is **no dbt Cloud and
no Tobiko Cloud** in the path, so the complete plan/apply/diff capability runs
DISCONNECTED in an IL5 enclave with no egress. That is the in-boundary
fallback — nothing about N4 degrades when the boundary has no internet.

## Deploy

`platform/fiab/bicep/modules/integration/transform-runner-aca.bicep`, activated
by the admin-plane orchestrator. The Console reads the internal endpoint as
`LOOM_TRANSFORM_RUNNER_URL` (gate `svc-transform-runner`).
