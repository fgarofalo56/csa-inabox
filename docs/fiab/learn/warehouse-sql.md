# Warehouse SQL

The Loom warehouse surface is a fully-managed T-SQL data warehouse: storage on
OneLake (Parquet/Delta), auto-scaling compute, no infrastructure to manage. The
SQL query editor builds the Fabric Warehouse / Synapse SQL experience
one-for-one — write T-SQL, run it against the real endpoint, and see results,
cost, and bytes processed.

## When to use it

- **Serve** curated Gold-layer tables to BI in T-SQL, with cross-database joins
  across any lakehouse SQL endpoint or mirrored database in the workspace.
- **DirectLake** semantic models for sub-second Power BI refresh over the
  warehouse.
- Ad-hoc **SQL analytics** over Delta tables produced by notebooks or pipelines.

For pay-per-query exploration over files in storage (no provisioned warehouse),
use the **Synapse serverless SQL pool** surface and `OPENROWSET` instead.

## The SQL query editor

Open the warehouse at `/items/warehouse/<id>`. The ribbon mirrors Fabric/Synapse:

- **Home** — connection + run controls.
- **Query** — **New SQL query**, **Run**.
- The schema explorer lists databases, schemas, tables, and **External
  tables**.
- For serverless, the editor also surfaces **Cost**, **Bytes processed**, and a
  **Cost cap** — so you see the price of a scan before and after running.

### Step-by-step: create, load, query

1. **New SQL query** from the ribbon. A blank T-SQL editor opens with the schema
   tree alongside.
2. Run standard DDL/DML — Loom executes it over the real TDS/SQL endpoint:

   ```sql
   CREATE TABLE dbo.sales_gold (
       sale_date date, region varchar(50), revenue decimal(18,2));

   INSERT INTO dbo.sales_gold
   SELECT CAST(date AS date), region, SUM(amount)
   FROM   silver_sales
   GROUP BY CAST(date AS date), region;
   ```

3. **Cross-database query** any lakehouse SQL endpoint or mirrored database in
   the same workspace with three-part names:

   ```sql
   SELECT g.region, g.revenue, c.tier
   FROM   dbo.sales_gold g
   JOIN   [mirror_crm].dbo.customers c ON c.region = g.region;
   ```

4. **Run** (toolbar or Ctrl+Enter). Results appear in the bottom grid; on
   serverless the **Bytes processed** / **Cost** read-outs update so you can
   tune scans.
5. **Connect Power BI** in **DirectLake** mode against the warehouse for
   sub-second semantic-model reads — no import refresh.

### Serverless cost discipline

When the endpoint is **Synapse serverless**, billing is metered by bytes
scanned. Filter on partitioned columns (year/month/day), select only the
columns you need, and read Parquet/Delta directly with `OPENROWSET(BULK ...,
FORMAT='PARQUET')` / `FORMAT='DELTA'`.

## Honest infra gate

If no SQL endpoint is wired, the editor shows a `MessageBar` naming the server
binding / Entra admin required — the query editor and schema tree still render.

## Learn more

- **MS Learn — [What is data warehousing in Microsoft Fabric?](https://learn.microsoft.com/fabric/data-warehouse/data-warehousing)**
- MS Learn — [Query the SQL analytics endpoint](https://learn.microsoft.com/fabric/data-engineering/lakehouse-sql-analytics-endpoint)
- MS Learn — [Serverless SQL pool (Synapse)](https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview)
- Loom editor guides — [Warehouse](../tutorials/editor-warehouse.md) · [Synapse serverless SQL pool](../tutorials/editor-synapse-serverless-sql-pool.md)
