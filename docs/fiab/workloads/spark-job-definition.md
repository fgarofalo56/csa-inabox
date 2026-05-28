# Spark Job Definition — workload reference

> **Family:** Data Engineering
> **Loom slug:** `spark-job-definition`
> **Editor file:** `apps/fiab-console/lib/editors/phase2-misc-editors.tsx`
> **BFF routes:** `app/api/items/spark-job-definition/**`
> **Parity spec:** [`fiab/spark-job-definition-parity-spec.md`](../spark-job-definition-parity-spec.md)

## Purpose

Submit a compiled Spark application (.py file, JAR, or wheel) to a
Synapse Spark pool via Livy. The editor captures `file`, `className`
(for JAR/Scala), `args`, `conf` (a `Map<string, string>` of Spark
properties), and the target pool. **Save** persists the spec to
Cosmos; **Submit** persists and then POSTs to the Livy batch endpoint.

## Fabric-parity gap

| Fabric feature | Loom state |
|---|---|
| Application file + class + args + conf | Shipped — full form |
| Submit | Shipped — Livy batch POST + state polling |
| Run history | Shipped — `/runs?size=20` populates the runs table |
| App-level logs | Gated — surfaced as link to Synapse Studio's job detail |
| Multi-pool failover | Not wired — single-pool target |

## Real backend it calls

- Cosmos `items` for the SJD spec.
- Synapse Spark via Livy:
  `POST /livyApi/versions/2019-11-01-preview/sparkPools/{pool}/batches`
  using ChainedTokenCredential(UAMI, default).

## Sample usage

1. Open `/items/spark-job-definition/<id>`.
2. Set `file = abfss://files@…/jobs/etl.py`, `pool = pool-default`.
3. Add args (one per line) and any required `spark.*` conf entries.
4. **Save** then **Submit**.
5. Watch the runs table for the batch state transition.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_SYNAPSE_WORKSPACE` | Livy dispatch | `landing-zone/synapse.bicep` |
| `LOOM_SYNAPSE_DEFAULT_POOL` | Initial pool selection | same |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI | `identity.bicep` |
