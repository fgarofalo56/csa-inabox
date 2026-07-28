# Tutorial: Streaming SQL editor

> CSA Loom `streaming-sql` editor — the **stateful** streaming tier above Azure
> Stream Analytics. Author streaming **materialized views** in SQL over Azure
> Event Hubs (consumed through the namespace's Kafka endpoint), maintained
> incrementally by an in-boundary **RisingWave** container and sunk to Delta /
> Iceberg on your own ADLS Gen2. Azure-native + OSS — **no Microsoft Fabric, no
> OneLake, no Power BI**.

## What it is

Azure Stream Analytics is the light default for simple pass-through jobs. It
cannot express multi-stream windowed joins or incremental aggregations that keep
state across an unbounded stream. Streaming SQL is that stateful tier: you write
`CREATE MATERIALIZED VIEW …` and RisingWave keeps the answer continuously
correct as events arrive — no batch re-computation, no Spark session.

Three tabs, all backed by real routes:

| Tab | What it does | Backend |
|---|---|---|
| **Author** | Monaco SQL editor + results pane; **Materialize** runs the DDL, **Preview** runs the SELECT body once as a read-only query | `POST /api/streaming-sql/mv`, `POST /api/streaming-sql/query` |
| **Materialized views** | Live status read from RisingWave's own catalog — each view's definition, backfill progress and current materialized row count | `GET /api/streaming-sql/status` |
| **Sources & sinks** | Dropdown-driven builders (no freeform config) that compile a structured spec into a real `CREATE SOURCE` / `CREATE SINK` | `POST /api/streaming-sql/mv` |

## When to use it

- You need a **join across two live streams** (for example enrich orders with
  customers as both arrive) kept correct continuously.
- You need incremental aggregations — running totals, windowed counts — that
  must be queryable at any instant, not recomputed on a schedule.
- You want the maintained result landed on the lake as Delta or Iceberg so
  batch consumers (Lakehouse, SQL Lab, Warehouse) see the same numbers.
- For a simple filter-and-forward job, a Stream Analytics job or an Eventstream
  is the cheaper choice.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Streaming SQL**. The editor opens at
   `/items/streaming-sql/<id>`. The header badge shows `RisingWave <version>`
   when the tier is deployed (or `Not deployed`), plus a live count of
   `<n> views · <n> sources · <n> sinks`.
2. **Define a source over Event Hubs.** Go to **Sources & sinks → Add an Event
   Hubs source**. The card prints the Kafka bootstrap endpoint it will use.
   Fill in **Source name**, **Event Hub (topic)**, **Columns** (`name type, …`),
   and **Payload format** (`JSON` / `AVRO` / `CSV`), then **Create source**.
   Loom compiles that structured spec into a real `CREATE SOURCE` — you never
   hand-write connection JSON.
3. **Author the materialized view.** On the **Author** tab write the DDL. The
   starter buffer is a two-stream join:
   ```sql
   CREATE MATERIALIZED VIEW orders_enriched AS
   SELECT o.order_id, o.amount, c.name AS customer_name
   FROM orders o
   JOIN customers c ON o.customer_id = c.customer_id;
   ```
   Use **Preview** first to run the `SELECT` body once, read-only, and confirm
   the shape (the status bar reports rows, elapsed ms, and the engine).
4. **Materialize it.** Click **Materialize**. On success a green MessageBar
   confirms the command that ran and that RisingWave is now maintaining the view
   incrementally; the status panel refreshes automatically.
5. **Watch it fill.** Switch to **Materialized views**. Each row shows the view
   name, its current materialized row count, and a **Backfill** badge — amber
   with the progress string while it catches up, green `up to date` once caught
   up. **Peek** on any row jumps back to Author and runs
   `SELECT * FROM <schema>.<view>` so you can see live rows.
6. **Sink it to the lake.** Back on **Sources & sinks → Add a lake sink**, pick
   the **From** view, the **Format** (`Delta` or `Iceberg`), and the target
   **Container** / **Path** on your own ADLS Gen2, then **Create sink**. The
   maintained view now lands continuously in the lake where every other Loom
   item can read it.

## The Azure backend it rides on

- **Engine:** an in-boundary **RisingWave** container on **Azure Container
  Apps** (`LOOM_RISINGWAVE_URL`), speaking the Postgres wire.
- **Ingest:** **Azure Event Hubs**, consumed through the namespace's **Kafka**
  endpoint (`LOOM_EVENTHUB_NAMESPACE`).
- **Sink / storage:** your own **ADLS Gen2**, written as Delta or Iceberg.
- **Serving:** the maintained views are queryable over the Postgres wire, and
  the sunk tables are readable by Lakehouse / SQL Lab / Warehouse.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| `LOOM_RISINGWAVE_URL` unset | The surface renders **fully** with a Fix-it gate card; the Materialized-views tab explains it needs the tier | Deploy the RisingWave tier and set `LOOM_RISINGWAVE_URL` (the Fix-it wizard walks it) |
| Tier deployed but unreachable | Warning MessageBar: *"The RisingWave tier did not answer"* with the upstream reason | Check the RisingWave Container App health / private networking |
| `LOOM_EVENTHUB_NAMESPACE` unset | The source builder notes no namespace is configured; you can still author a source against an explicit hub | Set `LOOM_EVENTHUB_NAMESPACE` to your Event Hubs namespace |
| `n7a-streaming-sql` flag off | Whole surface reverts to a guided notice; the tier, its routes and every other editor keep working | Re-enable the flag in **Admin → Runtime flags** |

The stateful tier is an **opt-in accelerator, never a blocker** — a fresh item
opens clean, with no red banner.

## No Fabric required

Container Apps + Event Hubs + ADLS Gen2. No Fabric capacity, workspace, OneLake
path, or Power BI workspace is used on any code path.

## Learn more

- Eventstream editor tutorial: `editor-eventstream.md`
- SQL Lab editor tutorial: `editor-sql-lab.md`
- Parity source: `docs/fiab/parity/streaming-sql.md`
- Event Hubs Kafka endpoint:
  <https://learn.microsoft.com/azure/event-hubs/azure-event-hubs-kafka-overview>
