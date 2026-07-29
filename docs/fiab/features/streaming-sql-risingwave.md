# Streaming SQL on RisingWave

> **Surface:** Streaming SQL editor (`/items/streaming-sql/<id>`) — **Author**, **Materialized views**, **Sources & sinks** tabs
> **Backend:** `loom-risingwave`, an internal-ingress Container App running single-node RisingWave (Apache-2.0), consuming Azure Event Hubs through the namespace's Kafka-protocol endpoint and sinking to Delta/Iceberg on your own ADLS Gen2
> **Kill-switch flag:** `n7a-streaming-sql` (default ON)
> **Honest gate:** `LOOM_RISINGWAVE_URL` (gate id `svc-loom-risingwave`) — the editor still renders fully

The **stateful** streaming tier above Azure Stream Analytics. Author streaming
**materialized views** in ordinary SQL over Event Hubs; RisingWave maintains
them incrementally and continuously, and the result is sunk to Delta/Iceberg on
your lake or served over the Postgres wire.

## Why it exists

Azure Stream Analytics is the light default and stays the right tool for simple
jobs. What it cannot express is the class of query that needs durable state:
windowed joins across two streams, incremental aggregations that must survive a
restart, a continuously-correct materialized view rather than a periodic batch.

RisingWave is a self-contained Rust binary with **no external control plane**.
It reaches only the in-VNet Event Hubs Kafka endpoint and in-boundary ADLS
Gen2 — no SaaS streaming service is in the path, so the whole tier runs
disconnected in an air-gapped enclave.

## How to use it end to end

1. **Create a Streaming SQL item** from the catalog.
2. **Sources & sinks tab — define a source.** The builders are
   dropdown-driven (no freeform config): pick the Event Hubs namespace, hub and
   consumer group, and the format. Loom compiles the structured spec to a
   `CREATE SOURCE` over the Event Hubs Kafka endpoint.
3. **Sources & sinks tab — define a sink.** Same shape: pick the target and Loom
   compiles a `CREATE SINK` writing Delta or Iceberg to your ADLS Gen2, so a
   streaming result lands in the same lake the batch world reads.
4. **Author tab — write the view.** A Monaco SQL editor over the shared
   resizable results split. Write the SELECT that defines your materialized
   view.
   - **Preview** runs a read-only `SELECT` against the tier
     (`/api/streaming-sql/query`) so you can check the shape before you commit.
   - **Materialize** runs the `CREATE MATERIALIZED VIEW`
     (`/api/streaming-sql/mv`).
5. **Materialized views tab — watch it fill.** The status panel is read from
   **RisingWave's own catalog** (`/api/streaming-sql/status`): each view's
   definition, its backfill progress, and its current materialized row count —
   throughput as it fills. Not a synthetic progress bar.
6. **Consume the result** from the sink (Delta/Iceberg on your lake, readable by
   every downstream Loom item and, via
   [Iceberg interop](iceberg-interop.md), by external engines) or directly over
   the Postgres wire.

## What the backend actually does

| Control | Backend |
|---|---|
| Preview | `POST /api/streaming-sql/query` -> read-only SELECT on RisingWave |
| Materialize | `POST /api/streaming-sql/mv` -> `CREATE MATERIALIZED VIEW` |
| Status panel | `GET /api/streaming-sql/status` -> RisingWave's own catalog |
| Source / sink builders | Structured specs compiled to `CREATE SOURCE` / `CREATE SINK` |
| Wire protocol | RisingWave speaks the PostgreSQL wire protocol on its frontend port, so the console talks to it with the same driver the Lakebase and Weave paths use — not an HTTP API |
| Audit | Streaming DDL is a privileged mutation and a query is a data-access event; both write an `_auditLog` row and fan out through the SIEM stream. Mutations emit the event first, synchronously, before the awaited Cosmos write. |

The container has **internal ingress**. The Console BFF is the sole door, and
every statement flows through the audited routes.

## Deployment (default ON) and honest gates

**`LOOM_RISINGWAVE_URL` is set by the deployment itself.** Since 2026-07-28
`admin-plane/main.bicep` deploys
`platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep` on every
apps-enabled deploy, in **every Container Apps boundary — Commercial, GCC,
GCC-High and IL5** — and wires `<fqdn>:4566` onto the Console. A fresh
push-button deploy closes the `svc-loom-risingwave` gate with no operator step.

**Cost, stated plainly.** This is the one runtime in the band that cannot honour
"scale to zero so default-ON stays cheap": a single-node RisingWave keeps its
materialized-view and meta state **in process**, so a scaled-to-zero replica
loses every MV definition and its progress. It therefore runs `minReplicas: 1`
at the smallest ACA-Consumption-legal footprint — **2.0 vCPU / 4.0 GiB** (the
profile requires memory == 2 x vCPU GiB). **Budget the ACTIVE rate: about $150
per month per cloud, 24/7.** Azure Container Apps applies its idle rate only
while a replica stays under 0.01 vCPU *and* under 1 KB/s
([billing](https://learn.microsoft.com/azure/container-apps/billing)), and an
engine running meta heartbeats, barriers and periodic compaction does not
qualify — planning against an "idle" figure understates the bill. Raise it to
the 4.0 vCPU / 8.0 GiB ceiling through the module's config bag for heavier
topologies.

**Durability caveat.** `minReplicas: 1` buys continuity *within a revision*, not
durability. The Container App has no volume mount and `RW_STATE_STORE` is unset
by default, so the replica filesystem is ephemeral: an ACA revision roll or a
platform replica replacement drops the materialized views regardless. Set
`stateStore` (→ `RW_STATE_STORE`) to the ADLS hummock store through the config
bag for a genuinely durable deployment.

**Admin opt-out (a disable toggle, never an enablement wizard).** Set
`observabilityConfig.backendOverrides.risingwave = 'disabled'` at the root
orchestrator (or `loomBackends.risingwave = 'disabled'` on the admin-plane
module) to skip the app entirely; `LOOM_RISINGWAVE_URL` is then emitted empty.
The var can also be blanked live from `/admin/env-config`.

**With the var unset the full editor still renders with a Fix-it gate**, never a
blocker: Azure Stream Analytics remains the light default for simple jobs, and
the `stream-analytics-job` item type is a separate surface that this gate does
not touch.

To wire it by hand (an already-running estate, or the incremental Gov path in
`.github/workflows/gov-provision-streaming-migrate.yml`): deploy
`platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep`, then set
`LOOM_RISINGWAVE_URL` on the Console app to the internal-ingress FQDN
(optionally `host:port`). Optional: `LOOM_RISINGWAVE_DATABASE` (default `dev`),
`LOOM_RISINGWAVE_USER` (default `root`), `LOOM_RISINGWAVE_PASSWORD` (a Key Vault
secret; the single-node default is in-VNet trust).

## Getting the image into a sovereign ACR (GCC-High / IL5)

The Container App is deployed by the same template in Gov, so the only Gov
prerequisite is the same one `loom-console` has: **the image must already be in
that boundary's registry**, at the tag `appImageTags.risingwave` resolves to
(`v0.1` by default in `params/gcc-high.bicepparam` and `params/il5.bicepparam`).
A Container App whose manifest is absent fails its PUT with `MANIFEST_UNKNOWN`.

Both Gov producers build **server-side** with `az acr build`, which is the only
mechanism that reaches a registry provisioned `publicNetworkAccess=Disabled`:

| Workflow | Use it for |
|---|---|
| `.github/workflows/build-fiab-images-acr-tasks.yml` (`boundary=GCC-High` or `IL5`) | The full image set, including `loom-risingwave` and `loom-migrate`. |
| `.github/workflows/gov-provision-streaming-migrate.yml` (`mode=build-only`) | Just these two, as phase 2 of a from-scratch install. `mode=build-and-deploy` also stands the Container Apps up and wires the vars on an estate that is already running. |

**Not** `build-fiab-images.yml` — it authenticates with the *Commercial* service
principal, never runs `az cloud set --name AzureUSGovernment`, and pushes
client-side, so it cannot produce a Gov image. It now hard-fails when dispatched
with a Gov boundary rather than silently producing nothing.

## Kill-switch

`n7a-streaming-sql` — default ON. Flipping it OFF replaces the editor body with
a guided notice on the next render. The `loom-risingwave` Container App, the
`/api/streaming-sql/**` routes, and every already-created item are unaffected.
**Azure Stream Analytics (`stream-analytics-job`) is a separate item type and is
not touched by this flag.**

## Related

- [Iceberg REST catalog and interop](iceberg-interop.md) — reading the sink from anywhere
- Editor guide — [Eventstream](../tutorials/editor-eventstream.md) · [Stream Analytics job](../workloads/stream-analytics-job.md)
- [Real-Time Intelligence parity](../workloads/real-time-intelligence.md)
