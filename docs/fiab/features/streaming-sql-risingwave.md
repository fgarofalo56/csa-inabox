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

## Honest gates

**`LOOM_RISINGWAVE_URL` unset renders the full editor with a Fix-it gate.** The
stateful tier is an opt-in accelerator (roughly $150-300 per month per cloud),
never a blocker: Azure Stream Analytics remains the light default for simple
jobs, and the `stream-analytics-job` item type is a separate surface that this
gate does not touch.

To wire it: deploy
`platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep`, then set
`LOOM_RISINGWAVE_URL` on the Console app to the internal-ingress FQDN
(optionally `host:port`). Optional: `LOOM_RISINGWAVE_DATABASE` (default `dev`),
`LOOM_RISINGWAVE_USER` (default `root`), `LOOM_RISINGWAVE_PASSWORD` (a Key Vault
secret; the single-node default is in-VNet trust).

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
