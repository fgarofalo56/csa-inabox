# Tutorial: SQL Lab editor

> CSA Loom `sql-lab` editor — the sub-second, read-only query surface over your
> own lake. An embedded **DuckDB** serving tier reads Delta / Iceberg / Parquet
> **in place** on your ADLS Gen2 through a managed identity; when that tier is
> not deployed the identical statement runs on **Synapse Serverless** instead.
> Azure-native end to end — **no Microsoft Fabric, no OneLake, no Power BI**.

## What it is

SQL Lab is the fast path *below* Spark. A Spark session costs one to five
minutes to start; SQL Lab answers interactive questions in well under a second
because it never moves your data — DuckDB opens the Delta / Iceberg / Parquet
files where they already live, using an identity that holds **Storage Blob Data
Reader**. It can therefore query everything and change nothing: the execution
edge enforces a read-only guard and refuses statements that would write.

Three tabs, all backed by real routes:

| Tab | What it does | Backend |
|---|---|---|
| **Query** | Monaco SQL (or PRQL) editor + results grid with an engine/timing status bar | `POST /api/duckdb/query` |
| **Local analysis** | Fetches the result once as an Arrow IPC stream, then slices / filters / aggregates it **in the browser** on duckdb-wasm | `POST /api/duckdb/query?format=arrow` |
| **Connect** | ADBC / Flight SQL / JDBC snippets plus a short-lived, Entra-scoped ticket for your own tools | shared Connect tab (audited BFF ticket mint) |

## When to use it

- You want to look at a lake table *right now* without waiting on a Spark pool.
- You want to profile or sample Bronze/Silver files (`read_parquet`, `delta_scan`,
  `iceberg_scan`) before writing a real pipeline.
- You want to hand an analyst an ADBC / Flight SQL endpoint so they can pull
  Arrow record batches into their own notebook or BI tool.
- Big joins, writes, and ML still belong on Spark — SQL Lab is deliberately
  read-only.

## Step-by-step in Loom

1. **Create the item.** **+ New item → SQL Lab**. The editor opens at
   `/items/sql-lab/<id>`. The toolbar badge names the engine that will answer —
   `DuckDB <version>` when the serving tier is deployed, `Synapse Serverless`
   otherwise — and a second badge lists the DuckDB extensions actually loaded.
2. **Write a read-only statement.** The Query tab opens with a starter buffer
   that shows the three lake-scan idioms:
   ```sql
   SELECT * FROM delta_scan('abfss://gold@<account>.dfs.core.windows.net/sales') LIMIT 100;
   SELECT * FROM read_parquet('abfss://bronze@<account>.dfs.core.windows.net/events/*.parquet');
   ```
   Drag the split between the editor and the results pane — the size is
   persisted per surface.
3. **Run it.** Click **Run** in the ribbon or the toolbar. The status bar under
   the grid reports `<rows> rows · <n> ms engine · <n> ms round-trip · <engine>`,
   and flags `truncated` when the 5,000-row display cap clipped the result.
4. **(Optional) Switch language to PRQL.** When the `n8-modern-query-prql`
   runtime flag is on (default), a **Language** dropdown offers `SQL` and
   `PRQL (Preview)`. PRQL pipelines (`from … | filter … | derive … | group … |
   sort … | take …`) are transpiled to SQL client-side and the **generated SQL is
   printed above the results** so you can see exactly what ran. If a construct is
   outside the supported subset, Loom shows an *Unsupported PRQL* error and runs
   **nothing** — it never fabricates a query it could not translate. SQL and PRQL
   have separate buffers, so switching never clobbers your work.
5. **(Optional) Switch engine to Federated SQL (Trino).** The **Engine**
   dropdown only offers `Federated SQL (Trino)` when the `n7e-trino-federation`
   flag is enabled — this is the documented **default-OFF** exception (it carries
   an AKS carve-out cost). DuckDB / Serverless stays the default either way, and
   a Trino run displays a `cross-source join` badge plus the catalogs the planner
   touched.
6. **Analyze locally at zero server cost.** Switch to **Local analysis**. Loom
   fetches the same statement once as Arrow (up to 200,000 rows) and every
   subsequent slice, filter, and aggregate runs on duckdb-wasm in your browser —
   the timing bar proves the network request count stays at zero.
7. **Connect your own tools.** The **Connect** tab prints the real endpoint and
   its honest exposure (published / in-VNet only / not deployed — an internal
   container FQDN is never printed because it would not resolve for you), then
   **Generate ticket** mints a short-lived Entra-scoped ticket through the
   audited BFF and shows its expiry. The copy-paste ADBC / Flight SQL / JDBC
   snippets read that ticket from *your* environment variable, so no secret is
   ever rendered on screen.

## The Azure backend it rides on

- **Engine (preferred):** the `loom-duckdb` Container App — embedded DuckDB with
  a managed identity onto ADLS Gen2. Deployed by
  `platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep`.
- **Engine (fallback):** **Synapse Serverless SQL** — same statement, same
  results, more latency.
- **Storage:** your own **ADLS Gen2** (Delta / Iceberg / Parquet), read in place.
- **Wire protocol:** Arrow IPC for the browser tier and for ADBC / Flight SQL
  clients; `/api/duckdb/capabilities` reports whether the Flight wire is up.
- **Audit:** every execution — success *or* failure — writes an `_auditLog`
  data-access row (principal, statement scope, engine, rows, outcome, timestamp)
  and fans out on the audit stream **before** the response is sent. There is no
  unaudited path to the serving tier.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| `LOOM_DUCKDB_URL` unset | Fix-it gate card; the surface still runs every query on **Synapse Serverless** | Deploy the DuckDB serving tier (`platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep`) and set `LOOM_DUCKDB_URL` |
| DuckDB tier deployed but unreachable | Warning MessageBar: *"The DuckDB serving tier did not answer"* with the upstream reason | Check the `loom-duckdb` Container App health / private networking |
| Local analysis on the Serverless path | Panel explains there is no Arrow payload to analyze (Serverless returns JSON) | Deploy the DuckDB tier — the browser tier is added free on top |
| `n7e-trino-federation` off | The Trino engine option is simply absent | Enable the flag in **Admin → Runtime flags**; the run then shows the Trino gate with its AKS cost disclosed |
| `n2b-sql-lab-duckdb` flag off | Whole surface reverts to a guided notice; the tier, its routes and every other editor keep working | Re-enable the flag in **Admin → Runtime flags** |

## No Fabric required

SQL Lab is Container Apps + ADLS Gen2 + Synapse Serverless. No Fabric capacity,
workspace, OneLake path, or Power BI workspace is touched on any code path.

## Learn more

- Lakehouse editor tutorial: `editor-lakehouse.md`
- Streaming SQL editor tutorial: `editor-streaming-sql.md`
- Parity source: `docs/fiab/parity/sql-lab-duckdb.md`
- Azure Synapse serverless SQL pool:
  <https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview>
