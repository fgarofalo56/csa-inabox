# Lakehouse Inspector — from install to a profiled medallion

Install `app-lakehouse-inspector` and get a **bronze / silver / gold medallion
lakehouse** on ADLS Gen2 + Delta, seeded with the retail-sales reference star schema,
plus a **companion notebook** that profiles every tier. It is the fastest way to see a
fully formed lakehouse rather than an empty file browser. **~20 minutes.**

!!! abstract "What you end up with"
    Two items: `Retail Sales Medallion Lakehouse` (10 seeded Delta tables + 10 folders
    + 1 shortcut) and `Lakehouse Inspector Walkthrough` (notebook). Azure-native
    throughout — ADLS Gen2 for storage, Synapse serverless for SQL, Spark for compute.
    No OneLake, no Fabric capacity.

## Prerequisites

| You need | Why | If it is missing |
| --- | --- | --- |
| A Loom workspace | Apps install into a workspace | [Tutorial 01 — First workspace](../01-first-workspace.md) |
| `LOOM_ADLS_ACCOUNT` | The lakehouse provisioner writes folders, seed CSVs, and Delta tables | Lakehouse row shows an honest gate naming the account |
| Console UAMI with **Storage Blob Data Contributor** on that account | Write the seed data | Verbatim `403` plus the role to grant |
| A Synapse serverless SQL endpoint (recommended) | Registers queryable views over the tables and the shortcut | Tables still land in ADLS; the SQL views do not |
| A Spark compute (Synapse Spark pool or Azure ML) | Run the walkthrough notebook | The notebook installs but has nothing to execute on |

## 1. Install the app

1. Left nav → **Apps** → **Lakehouse Inspector** (`/apps/app-lakehouse-inspector`).
2. **Install into workspace** → workspace, optional folder (e.g. `Lakehouse`).
3. **Deploy artifacts to live Azure services** → **On**. **Compute** → **Shared**.
4. **Install**.

## 2. What gets provisioned

| Item | Provisioner | Real backend |
| --- | --- | --- |
| `Retail Sales Medallion Lakehouse` (`lakehouse`) | `lakehouseProvisioner` | ADLS Gen2 folder layout; seed rows landed as CSV then loaded to managed Delta; the declared shortcut uploaded into the tenant's own storage and registered |
| `Lakehouse Inspector Walkthrough` (`notebook`) | `notebookProvisioner` | Synapse (`LOOM_SYNAPSE_WORKSPACE`) nbformat artifact, or Databricks (`LOOM_DATABRICKS_HOSTNAME`) SOURCE notebook under `/Shared/loom-installs/…` |

### Folder layout — it mirrors dbt exactly

Ten folders, `bronze/<entity>/` → `silver/<entity>/` → `gold/<dim_or_fact>/`:

| Tier | Folders | What lives there |
| --- | --- | --- |
| **bronze** | `sales/`, `customers/`, `products/` | Raw landings. Sales partitioned by ingestion date (`YYYY/MM/DD`); customers and products are daily full snapshots. No transformation — materialized as views in dbt |
| **silver** | `sales/`, `customers/`, `products/` | Cleansed. Sales type-cast and null-filtered (`order_id NOT NULL`, `quantity > 0`, `unit_price >= 0`), incremental on `_ingested_at`. Customers canonicalized to one row per `customer_id` + `ingestion_ts`. Products title-cased with `list_price` validated $0–$100K |
| **gold** | `dim_customer/`, `dim_product/`, `dim_date/`, `fact_sales/` | SCD Type 2 customer and product dimensions (surrogate `*_key`, `valid_from` / `valid_to` / `is_current`), a static `dim_date` (1900-01-01 → 2099-12-31, `date_key` = `YYYYMMDD`), and `fact_sales` at order-line grain with role-playing `order_date_key` / `ship_date_key` and pre-computed `extended_amount` / `cost_amount` / `margin_amount` |

## 3. Seeded data

**Ten Delta tables**, seeded at install:

`bronze_sales`, `bronze_customers`, `bronze_products`,
`silver_sales`, `silver_customers`, `silver_products`,
`dim_customer`, `dim_product`, `dim_date`, `fact_sales`.

Plus **one shortcut**: `retail-orders-public` — a 267-row retail-orders CSV that ships
in the repo (`samples/app-data/lakehouse-inspector/retail-orders-public.csv`).

!!! info "Why the shortcut is self-contained"
    A shortcut that points at an external URL can 404 tomorrow. This one is a
    `repoDataset`: at install the provisioner reads the real file, uploads it into
    **your** ADLS under the lakehouse's `Files/_shortcuts/retail-orders-public/`,
    registers a real internal shortcut row, and — when Synapse serverless is
    configured — a queryable `OPENROWSET` view. It demonstrates the zero-copy pattern
    with nothing external to reach.

The schema is the `examples/fabric-e2e` reference architecture: 3 dimensions + 1 fact,
with the same column contracts as `contracts/dim_customer.yaml`, `dim_product.yaml`,
`dim_date.yaml`, and `fact_sales.yaml`.

## 4. First meaningful task — profile the medallion

Open **`Lakehouse Inspector Walkthrough`**, attach a compute in the ribbon's compute
picker, and run the cells. They are idempotent — run any of them in any order.

1. **List every Delta table across all three tiers** — iterates
   `spark.catalog.listTables(tier)` for `bronze` / `silver` / `gold` and shows tier,
   table, and type. Expect ten rows. *This is the single best "did the install
   actually work" check.*
2. **Row counts per tier** — the profiling baseline.
3. **Null counts on primary keys** — the data-quality smoke test. `order_id`,
   `customer_id`, and `product_id` must be zero-null; anything else means the seed or
   your own load broke the contract.
4. **Sample queries against the gold star schema** — `fact_sales` joined to its
   dimensions:
   - top customers by margin,
   - category margin percentage.
5. **Read the `retail-orders-public` shortcut** — proves the zero-copy path resolves
   from Spark, not just from the file browser.

Then leave the notebook and open the **lakehouse editor** itself:

- The **Files** tree shows raw uploads on ADLS Gen2 (including
  `Files/_shortcuts/retail-orders-public/`); the **Tables** tree shows managed Delta.
- Drop your own CSV into a `bronze/<entity>/` folder and use **Load to Tables** to
  infer the schema and write a managed Delta table — no DDL.
- Query the SQL analytics endpoint with T-SQL, or read Delta from a notebook with
  `spark.read.format('delta')`.

## 5. Verify it worked

- **Install dialog**: the lakehouse row is `created`, and its step log lists the folder
  creations, the seeded table loads, and the shortcut upload + registration.
- **Notebook cell 1** returns **ten** tables across the three tiers.
- **Notebook cell 3** returns zero nulls on every primary key.
- **Lakehouse editor → Files** shows `Files/_shortcuts/retail-orders-public/` with the
  CSV in it.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Lakehouse row = `remediation` | `LOOM_ADLS_ACCOUNT` unset | Set it, restart the Console revision, **Retry** the row |
| Verbatim `403` on the seed write | UAMI lacks storage rights | Grant **Storage Blob Data Contributor** on the ADLS account |
| Cell 1 returns fewer than ten tables | Some seeds failed, or the Spark catalog is not pointed at the lakehouse databases | Read the install step log for the failed loads, then re-run the install (idempotent) |
| Shortcut folder exists but no SQL view | Synapse serverless is not configured | Configure the serverless endpoint; the file-level shortcut still works from Spark |
| Notebook has no compute to run on | No Spark pool / AML compute attached | Pick one in the ribbon's compute picker; a cold Synapse Spark pool takes ~2 minutes for the first session |
| Notebook cell fails with a catalog error | The Spark session's default filesystem container does not exist | Loom sets `fs.azure.createRemoteFileSystemDuringInitialization=true` on Livy sessions; if you are running outside Loom, create the container first |

## Cleanup

Delete both items, or the workspace. **The ADLS folders, Delta tables, and the
uploaded shortcut file are real** — remove them from storage if you want the space
back.

## What's next

- [Editor guide — Lakehouse](../editor-lakehouse.md) — every control in the editor.
- [Tutorial 02 — First Lakehouse + Delta tables](../02-first-lakehouse.md) — build one
  by hand instead of installing it.
- [Pipeline Designer](pipeline-designer.md) — the orchestrators that keep a medallion
  like this fresh.
- [Supercharge medallion journey](supercharge-medallion.md) — the same medallion idea
  at 117-notebook scale.
