# Tutorial: Synthetic data editor

> CSA Loom `synthetic-data` editor — generate realistic-looking but **entirely
> fabricated** rows from per-column strategies, preview them, then write a real
> **Delta** table through Databricks SQL. PII-classified source columns are
> mapped to **synthetic** strategies — fake names and emails, never real data.
> Azure-native — **no Microsoft Fabric**.

## What it is

Development, demos, load tests, and training courses all need data that looks
real without *being* real. This item lets you declare a schema — either by hand
or seeded from a **data contract** — assign each column a generation strategy,
preview a sample, and then materialize a full table (up to 200,000 rows) into
Unity Catalog as Delta.

Two tabs: **Design** and **Runs**.

## When to use it

- You need a populated table in a lower environment without copying production.
- You want the *shape* of a data contract's schema, with none of its PII.
- You need reproducible data — the same seed produces the same rows.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Synthetic data**, then **Create synthetic
   data generator**.
2. **Choose a source schema.** In **Source schema** pick either:
   - **Define columns** — start from an empty grid, or
   - **From a data contract** — pick a contract in this workspace; its columns
     seed the grid and strategies are **inferred**, with PII-classified columns
     mapped to synthetic strategies automatically.
3. **Set a strategy per column.** In **Columns & generation strategy**, each row
   has a name, a type, a strategy, its options, and a null-rate percentage:

   | Family | Strategies | Options you fill |
   |---|---|---|
   | Keys | Sequence (auto-increment), UUID | start at |
   | Numeric | Integer (uniform range), Decimal (uniform range), Number (normal distribution) | min/max, decimals, mean/stddev |
   | Temporal | Date (range), Timestamp (range) | start / end |
   | Discrete | Boolean, Categorical (from values), Constant | comma-separated values, value |
   | Synthetic identity | Full name, First name, Last name, Email, Phone, Street address | — |
   | Synthetic other | Company, City, Country, Redacted (mask token) | — |

   **Add column** and the per-row delete button manage the grid.
4. **Set volume and reproducibility.** **Rows to generate** (up to 200,000) and
   **Seed** — the same seed reproduces the same rows exactly.
5. **Choose the write target.** In **Write target**, cascading dropdowns of your
   real Databricks estate: **SQL warehouse** → **Catalog** → **Schema** →
   **Staging volume** (the UC volume used to stage the rows), plus a **Table
   name** for the new Delta table.
6. **Preview.** **Preview sample** generates up to 10 real rows through the
   backend and renders them in a table. Preview works **even with no Databricks
   backend configured** — only the write needs one.
7. **Generate.** **Generate table** saves any pending edits, generates the full
   row set, stages it to the volume, and creates the real Delta table through
   Databricks SQL.
8. **Check the record.** **Runs** lists every generation: started, target,
   requested rows, rows written, and status (`succeeded` / `partial` / `failed`)
   with the error when one occurred.

## The Azure backend it rides on

- **Write path:** **Databricks SQL** over **Unity Catalog** — rows are staged to
  a UC volume and registered as a real Delta table (the `createUcTableFromFile`
  path).
- **Generation + preview:** the server-side generator
  (`POST …/preview`, `POST …/generate`).
- **Catalog browsing:** `GET …/catalog` lists the real warehouses, catalogs,
  schemas, and volumes you can reach.
- **Persistence:** the item's own state holds the column specs, target, and run
  history.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| Databricks not configured | Warning MessageBar *"Databricks not configured"* naming the exact env var, and stating plainly that **preview still works** | Set the named variable (plus a SQL warehouse) on the `loom-console` env |
| Target incomplete | **Generate table** disabled with *"Add columns and pick a warehouse, catalog, schema, volume and table to generate."* | Complete the cascade |
| No data contracts in the workspace | The **From a data contract** radio is disabled with a hint | Author a `data-contract` item with a schema first |
| Generation partially fails | The run is recorded as `partial` with rows written and the error | Read the error, adjust the spec, re-run |

## PII posture

Strategies flagged as synthesizing PII (full name, first / last name, email,
phone, street address) produce **fabricated** values. When columns are seeded
from a data contract, PII-classified columns are mapped to those synthetic
strategies automatically — no real data is ever read or copied.

## No Fabric required

Databricks SQL + Unity Catalog + Delta. No Fabric capacity, workspace, OneLake
path, or Power BI workspace is used on any path.

## Learn more

- Data contract editor tutorial: `editor-data-contract.md`
- Databricks SQL warehouse editor tutorial: `editor-databricks-sql-warehouse.md`
- Azure Databricks SQL: <https://learn.microsoft.com/azure/databricks/sql/>
