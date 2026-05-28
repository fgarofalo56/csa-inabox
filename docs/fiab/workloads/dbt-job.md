# dbt Job — workload reference

> **Family:** Data Engineering
> **Loom slug:** `dbt-job`
> **Editor file:** `apps/fiab-console/lib/editors/phase2-misc-editors.tsx`
> **BFF routes:** `app/api/items/dbt-job/**`
> **Parity spec:** [`fiab/dbt-job-parity-spec.md`](../dbt-job-parity-spec.md)

## Purpose

Run a dbt project on a Databricks Job cluster. The editor's form
captures `projectDir`, `dbtCommand` (`run` / `test` / `build` / `seed`
/ `compile`), `target` (profile target), and optional `select` /
`exclude` filters. **Save** persists the spec to Cosmos; **Run**
materialises a Databricks Job with a `dbt_task` and triggers
`run-now`. Runs come from `jobs/runs/list`.

## Fabric-parity gap

dbt is not a Fabric native item — this surface is Loom-additive. The
gap-spec compares Loom's dbt job to **dbt Cloud** (which most teams
already pay for):

| dbt Cloud feature | Loom state |
|---|---|
| Edit dbt command + target | Shipped |
| Run with logs | Shipped — surfaced via Databricks run page link |
| Manifest browser | Gated — defer to dbt docs site / S3 upload |
| Documentation hosting | Gated — host via Databricks Bundle output |
| Run history | Shipped |
| Source freshness | Gated — schedule via Databricks Workflows |

## Real backend it calls

- `databricks-client.ts` — Databricks Jobs API
  (`/api/2.1/jobs/create` + `/api/2.1/jobs/run-now` +
  `/api/2.1/jobs/runs/list`).
- Cosmos `items` for the dbt-job spec.

## Sample usage

1. Push your dbt project to the repo linked to the workspace.
2. Open `/items/dbt-job/<id>`.
3. Set `projectDir = analytics`, `dbtCommand = run`, `target = prod`.
4. **Save** then **Run**.
5. Inspect the Databricks Run page for logs.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_DATABRICKS_HOST` | Databricks workspace URL | `landing-zone/databricks.bicep` |
| `LOOM_DATABRICKS_TOKEN_SECRET` | KV ref to PAT | databricks SCIM bootstrap |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI | `identity.bicep` |
