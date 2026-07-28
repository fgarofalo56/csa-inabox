# FinOps Cost Optimizer — from install to a report that shows real spend

Install `app-finops-cost`, get a **seeded cost lakehouse**, a **star-schema semantic
model with 13 DAX measures**, a **5-page executive report that renders real values on
first open**, and a **4-tile live-spend KQL dashboard**. **~25 minutes.**

!!! abstract "What you end up with"
    Four items: `FinOps Cost Lakehouse`, `FinOps Cost Semantic Model`,
    `FinOps Monthly Executive Report`, `FinOps Live Spend`. The report is the
    interesting one: the install-time report binder rewrites it into a **direct query
    over the seeded lakehouse tables**, so it shows numbers immediately instead of a
    "choose a data source" gate.

## Prerequisites

| You need | Why | If it is missing |
| --- | --- | --- |
| A Loom workspace | Apps install into a workspace | [Tutorial 01 — First workspace](../01-first-workspace.md) |
| `LOOM_ADLS_ACCOUNT` (+ the medallion containers) | The lakehouse provisioner writes Delta/CSV into ADLS Gen2 | Lakehouse row shows an honest gate naming the account |
| A Synapse serverless SQL endpoint configured | The report's direct query reads the seeded tables via `OPENROWSET` | The report binds but cannot execute |
| `LOOM_KUSTO_CLUSTER_URI` (optional) | The `FinOps Live Spend` dashboard needs an ADX data source | Dashboard row shows a remediation gate |
| An ADX `billing_events` table (optional) | The four live tiles query it by name | See the caveat below |

!!! warning "Live Spend vs the report — two different data paths"
    The **report** runs on the *seeded lakehouse* and works on day one. The
    **`FinOps Live Spend` dashboard** queries an ADX table called `billing_events`
    (Cost Management exports streamed in via Event Grid) that **this app does not
    create**. Its tiles error until that table exists in the database the dashboard
    resolves to — the bundle sets no explicit `database`, so it falls back to
    `LOOM_KUSTO_DEFAULT_DB`. Plan for that before you judge the dashboard.

## 1. Install the app

1. Left nav → **Apps** → **FinOps Cost Optimizer** (`/apps/app-finops-cost`).
2. **Install into workspace** → workspace, optional folder (e.g. `FinOps`).
3. **Deploy artifacts to live Azure services** → **On**. **Compute** → **Shared**.
4. **Install**, then watch the async job report.

Item order matters and is deliberate: the **lakehouse provisions first** so its CSVs
are on disk before the report binder runs.

## 2. What gets provisioned

| Item | Provisioner | Real backend |
| --- | --- | --- |
| `FinOps Cost Lakehouse` (`lakehouse`) | `lakehouseProvisioner` | ADLS Gen2 folders + Delta tables; sample rows landed as CSV then loaded to managed Delta |
| `FinOps Cost Semantic Model` (`semantic-model`) | `semanticModelProvisioner` | TMSL model (Azure-native tabular layer; a Fabric/Power BI workspace is opt-in only) |
| `FinOps Monthly Executive Report` (`report`) | `reportProvisioner` + the install-time **report binder** | Rewritten to a `direct-query` data source: one denormalized `SELECT` joining the seeded fact + dim via the model's relationship keys, exposed as the derived table `Query` |
| `FinOps Live Spend` (`kql-dashboard`) | `kqlDashboardProvisioner` | Confirms the ADX cluster + database; tiles run live KQL through `/api/items/kql-dashboard/<id>?run=1` |

### Why the report actually renders

A bundle report is authored at the **semantic-model** level (`FactSales[Total Sales]`
style refs). Left alone it would open on a "choose a data source" gate, and binding it
to the fact + dims would produce `multi-table` gates because the Loom-native report
executor does not join. The binder solves both: it emits one flattened direct query and
rewrites every visual into single-table `config.wells` over `Query`, resolving each
measure to its base column plus an aggregation. That only works because the lakehouse
table and column names deliberately match the model (`BillingFact` / `DimService`,
`BilledCost` / `AmortizedCost` / `ServiceFamily`, …).

## 3. Seeded data

**`billing.BillingFact`** — 12 rows of denormalized daily Cost Management billing
across April–June 2026, deliberately carrying `Owner` / `CostCenter` /
`SubscriptionName` / `Month` / `MonthName` / `Year` on the fact so the by-owner and
trend visuals resolve without seeding every dimension:

| ResourceId | Subscription | Owner | Cost centre | Months |
| --- | --- | --- | --- | --- |
| `aks-prod-eastus` | Production-Platform | Priya Nair | CC-1001 | Apr / May / Jun |
| `sqldb-orders-prod` | Production-Platform | Marcus Reed | CC-1001 | Apr / May |
| `stblobanalytics01` | Analytics-Shared | Dana Kim | CC-2100 | Apr / Jun |
| `aoai-copilot-eastus` | AI-Innovation | Sam Ortiz | CC-3300 | Apr / May / Jun |
| `vm-batch-scoring` | DataScience-Sandbox | Dana Kim / Marcus Reed | CC-2100 / CC-4200 | May / Jun |

**`billing.DimService`** — 5 rows: Azure Kubernetes Service (Compute /
Mission-Critical), Azure SQL Database (Databases / Business-Critical), Storage Accounts
(Storage / Standard), Azure OpenAI (AI + Machine Learning / Premium), Virtual Machines
(Compute / Standard).

The semantic model is wider than the seed — `BillingFact` declares 24 columns and six
dimensions (`DimService`, `DimSubscription`, `DimRegion`, `DimEnvironment`, `DimTag`,
`DimDate`). Measures beyond the seeded columns (`Reserved Spend %`, `Idle Spend`, …)
need a real Cost Management export before they mean anything.

### The 13 measures

`Total Spend`, `Amortized Spend`, `MoM Growth`, `YoY Growth`, `Forecast Spend (3M)`,
`Unit Cost`, `Reserved Spend %`, `On-Demand Spend %`, `Untagged Spend`,
`Untagged Spend %`, `Idle Spend`, `Idle Spend %`, `Top Service Spend`.

The last four are the FinOps Foundation "actionable" set — untagged and idle spend are
the two levers that pay for the exercise.

## 4. First meaningful task — read the report, then re-slice it

1. Open **`FinOps Monthly Executive Report`**. Five pages:
   **Executive Summary**, **By Service**, **By Owner & Cost Center**,
   **Forecast & Anomalies**, **Recommendations**.
2. On **Executive Summary**, the `Total Spend (This Month)` card must show a dollar
   value, not a gate. That single card is the proof that the binder ran and the
   Synapse endpoint answered.
3. Go to **By Owner & Cost Center**. With the seed, spend concentrates on
   `aoai-copilot-eastus` (Sam Ortiz / CC-3300) growing month over month — the shape a
   real AI-spend conversation starts from.
4. Open **`FinOps Cost Semantic Model`** and inspect a measure, e.g.
   `Untagged Spend % = DIVIDE ( [Untagged Spend], [Total Spend] )`. This is the
   allocation lever: anything untagged cannot be charged back.
5. Swap in your own data: replace the seeded `BillingFact` rows with a real Cost
   Management daily export (same column names) in **`FinOps Cost Lakehouse`**, then
   reopen the report. Because the binder resolved *columns*, not row values, the
   report follows your data.

### The live dashboard (when you have `billing_events`)

Open **`FinOps Live Spend`**. Four tiles:

1. **Spend Today (Running Total)** — card, `sum(billed_cost)` for `startofday(now())`.
2. **Hourly Spend Trend — Last 24 Hours** — timechart, `bin(billing_time, 1h)`.
3. **Top 10 Services by Spend (24h)** — barchart by `service_name`.
4. **Anomalies — Subscriptions with > 50% Daily Spend Increase** — table, today joined
   to yesterday on `subscription_id`, filtered to `GrowthPct > 50`.

## 5. Verify it worked

- **Install dialog**: lakehouse row `created` with the ADLS path; report row `created`.
- **Report → Executive Summary**: `Total Spend (This Month)` shows a number.
- **Lakehouse editor → Tables**: `BillingFact` (12 rows) and `DimService` (5 rows).
- **Dashboard**: tile 1 returns a card, or an honest Kusto error if `billing_events`
  does not exist yet.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Report opens on "choose a data source" | The binder did not run — usually the lakehouse row failed first | Fix the lakehouse gate, then **Retry** the report row (or re-run the install; it is idempotent) |
| Report binds but every visual is empty | Synapse serverless cannot read the seeded CSVs | Confirm the serverless endpoint is configured and the Console UAMI has **Storage Blob Data Reader** on the ADLS account |
| A visual shows a `multi-table` gate | The visual was hand-edited back to a cross-table well | Re-point it at a `Query` column — the Loom-native executor is single-FROM by design |
| Lakehouse row = `remediation` | `LOOM_ADLS_ACCOUNT` unset | Set it, restart the revision, **Retry** |
| Dashboard tiles error "billing_events not found" | The ADX table does not exist | Stream Cost Management exports into ADX, or edit the tile KQL to your own table |
| `Reserved Spend %` / `Idle Spend` are zero | Seeded rows have no `IsReserved` / `IsIdle` columns | Expected — they arrive with a real Cost Management export |

## Cleanup

Delete the four items, or the workspace. The ADLS folders the lakehouse created are
real — remove them from storage if you want the space back.

## What's next

- [Lakehouse Inspector](lakehouse-inspector.md) — the same lakehouse mechanics with a
  fuller medallion and a profiling notebook.
- [Workspace Monitoring](workspace-monitoring.md) — platform-side utilization to pair
  with billing-side spend.
