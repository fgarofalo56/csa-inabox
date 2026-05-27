# Environment — workload reference

> **Family:** Data Engineering
> **Loom slug:** `environment`
> **Editor file:** `apps/fiab-console/lib/editors/phase2-misc-editors.tsx`
> **BFF routes:** `app/api/items/environment/**`
> **Parity spec:** [`fiab/environment-parity-spec.md`](../environment-parity-spec.md)

## Purpose

Reusable Spark environment spec: `requirements.txt` content, JAR
paths, and `spark.*` configuration overrides. Applied to a Synapse
Spark pool via **Apply to pool**, which merges the environment's
`requirements` / `conf` / `jars` into the pool's `libraryRequirements`
+ `sparkConfigProperties` + `customLibraries` and PUTs the result.

## Fabric-parity gap

| Fabric feature | Loom state |
|---|---|
| Edit requirements / conf / jars | Shipped |
| Apply to pool | Shipped — full ARM PUT |
| Pool selector | Shipped — driven by `/api/items/synapse-spark-pool/list` |
| Compute hours analytics | Gated — Synapse cost API integration deferred |

## Real backend it calls

- Cosmos `items` for environment spec.
- ARM `Microsoft.Synapse/workspaces/.../bigDataPools` for the apply
  operation (`synapse-pool-arm.ts` family of helpers).

## Sample usage

1. Open `/items/environment/<id>`.
2. Paste `pandas==2.1.4\nnumpy==1.26.2` into requirements.
3. Add `{ "spark.executor.memory": "8g" }` to conf.
4. Pick a target pool from the dropdown.
5. **Save** then **Apply to pool**.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_SYNAPSE_WORKSPACE` | Pool target host | `landing-zone/synapse.bicep` |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI | `identity.bicep` |
