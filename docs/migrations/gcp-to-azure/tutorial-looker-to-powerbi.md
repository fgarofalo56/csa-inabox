# Tutorial: Convert Looker / LookML to Power BI Semantic Model

**A hands-on, step-by-step walkthrough for BI engineers and analytics teams migrating Looker dashboards and LookML models to Power BI with Microsoft Fabric, following csa-inabox patterns.**

**Estimated time:** 3-5 hours per LookML project
**Difficulty:** Intermediate
**GCP experience assumed:** Looker dashboards, LookML authoring, explores

---

## Prerequisites

Before starting this tutorial, ensure you have the following:

| Requirement                    | Details                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Looker instance**            | Admin or Developer access to export LookML projects                                                  |
| **Looker API credentials**     | Client ID and secret for the Looker API (Settings > Users > API3 Keys)                               |
| **Git access**                 | To the LookML repository backing your Looker project                                                 |
| **Microsoft Fabric workspace** | With Contributor or Admin permissions                                                                |
| **Power BI Desktop**           | Latest version installed locally                                                                     |
| **Tabular Editor 3**           | For advanced semantic model editing (optional but recommended)                                       |
| **Fabric lakehouse**           | With Delta tables already loaded (see [BigQuery to Fabric tutorial](tutorial-bigquery-to-fabric.md)) |
| **dbt Core**                   | `pip install dbt-databricks` (for derived table conversion)                                          |

> **GCP comparison:** Looker models are defined in LookML, a proprietary YAML-like language that lives in Git. Power BI semantic models use a TMDL/XMLA format with Git integration via Fabric deployment pipelines. The modeling concepts are analogous but the syntax is completely different.

---

## Scenario

You are migrating a Looker instance with:

- A LookML project `acme_analytics` containing 3 model files and 12 view files
- An explore `sales_explore` joining `fact_sales_daily`, `dim_region`, `dim_product`, and `dim_date`
- 8 Looker dashboards consumed by 50+ users
- Row-level security based on Looker user attributes
- Scheduled dashboard deliveries to stakeholders via email

By the end of this tutorial you will have an equivalent Power BI semantic model with Direct Lake, rebuilt dashboards, row-level security, and scheduled subscriptions.

---

## Step 1: Export LookML model

### 1.1 Clone the LookML repository

```bash
# LookML projects live in Git; clone the repository
git clone git@github.com:acme-gov/acme_analytics.git
cd acme_analytics
```

### 1.2 Inventory views, explores, and measures

Review the LookML structure:

```
acme_analytics/
├── models/
│   ├── sales.model.lkml
│   └── finance.model.lkml
├── views/
│   ├── fact_sales_daily.view.lkml
│   ├── dim_region.view.lkml
│   ├── dim_product.view.lkml
│   ├── dim_date.view.lkml
│   ├── order_lines.view.lkml
│   └── ... (7 more view files)
└── dashboards/
    ├── sales_overview.dashboard.lkml
    └── ... (7 more dashboard files)
```

### 1.3 Document explores and their joins

From `sales.model.lkml`:

```lookml
explore: sales_explore {
  label: "Sales Analysis"
  view_name: fact_sales_daily

  join: dim_region {
    type: left_outer
    sql_on: ${fact_sales_daily.region} = ${dim_region.region_id} ;;
    relationship: many_to_one
  }

  join: dim_product {
    type: left_outer
    sql_on: ${fact_sales_daily.product_id} = ${dim_product.product_id} ;;
    relationship: many_to_one
  }

  join: dim_date {
    type: left_outer
    sql_on: ${fact_sales_daily.sales_date} = ${dim_date.date_key} ;;
    relationship: many_to_one
  }
}
```

### 1.4 Extract all dimensions and measures

Build a mapping inventory from the LookML views:

```lookml
# From fact_sales_daily.view.lkml
view: fact_sales_daily {
  sql_table_name: `acme-gov.finance.fact_sales_daily` ;;

  dimension: sales_date {
    type: date
    sql: ${TABLE}.sales_date ;;
  }

  dimension: region {
    type: string
    sql: ${TABLE}.region ;;
  }

  dimension: product_id {
    type: string
    sql: ${TABLE}.product_id ;;
  }

  measure: total_units_sold {
    type: sum
    sql: ${TABLE}.units_sold ;;
  }

  measure: total_revenue {
    type: sum
    sql: ${TABLE}.gross_amount ;;
    value_format_name: usd
  }

  measure: avg_order_value {
    type: average
    sql: ${TABLE}.gross_amount ;;
    value_format_name: usd
  }

  measure: row_count {
    type: count
  }
}
```

---

## Step 2: Map LookML concepts to Power BI

### 2.1 Concept mapping table

| LookML concept                     | Power BI equivalent                | Migration notes                                                 |
| ---------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| **Model** (`.model.lkml`)          | Semantic model                     | One Power BI semantic model per Looker model                    |
| **View** (`.view.lkml`)            | Table in semantic model            | Each LookML view becomes a table                                |
| **Explore**                        | Report page or set of report pages | Explore join graph becomes the star schema relationships        |
| **Dimension**                      | Column                             | Dimensions map to columns; add to tables in the model           |
| **Dimension group** (time)         | Date hierarchy                     | Use `dim_date` table with calendar hierarchy                    |
| **Measure** (sum, count, avg)      | DAX measure                        | Port to DAX using conversion table below                        |
| **Derived table** (SQL)            | dbt model                          | SQL-based derived tables become dbt SQL models                  |
| **Derived table** (native)         | dbt model or calculated table      | Native derived tables port to dbt or Power BI calculated tables |
| **Persistent derived table (PDT)** | dbt incremental model              | PDTs map directly to dbt incremental materialization            |
| **LookML refinement**              | Measure group / calculation group  | Advanced pattern; port case-by-case                             |
| **Access filter**                  | Row-level security (RLS)           | Port to DAX RLS expressions                                     |
| **User attribute**                 | Entra ID group or UPN              | User attributes become Entra ID claims                          |
| **Set**                            | Field set in model view            | Define visible columns per report page                          |
| **Dashboard**                      | Power BI report                    | Visual-by-visual rebuild                                        |
| **Look**                           | Power BI report page               | Single-visualization Looks become report pages                  |
| **Schedule**                       | Power BI subscription              | Email delivery via Power BI subscriptions                       |
| **Alert**                          | Data Activator rule                | Threshold alerts port to Data Activator                         |
| **Action**                         | Power Automate flow                | Looker Actions port to Power Automate                           |

### 2.2 Relationship mapping

Looker explores define joins that become Power BI relationships:

| Looker join type | Power BI relationship         | Cardinality             |
| ---------------- | ----------------------------- | ----------------------- |
| `left_outer`     | Single direction, many-to-one | Default for fact-to-dim |
| `inner`          | Both directions, many-to-one  | Less common             |
| `full_outer`     | Many-to-many (with caution)   | Rare; avoid if possible |
| `cross`          | Calculated table              | Port to DAX `CROSSJOIN` |

---

## Step 3: Create Power BI semantic model in Fabric

### 3.1 Connect to the Fabric lakehouse

1. Open Power BI Desktop
2. **Get Data > Microsoft Fabric > Lakehouses**
3. Select the lakehouse containing your Delta tables from the BigQuery migration
4. Select tables: `fact_sales_daily`, `dim_region`, `dim_product`, `dim_date`
5. Click **Load** (or **Transform Data** if you need to adjust types)

### 3.2 Define relationships (star schema)

In **Model View**, create relationships mirroring the LookML explore joins:

| From (fact)                    | To (dimension)            | On columns              | Cardinality | Cross-filter |
| ------------------------------ | ------------------------- | ----------------------- | ----------- | ------------ |
| `fact_sales_daily[region]`     | `dim_region[region_id]`   | region = region_id      | Many-to-one | Single       |
| `fact_sales_daily[product_id]` | `dim_product[product_id]` | product_id = product_id | Many-to-one | Single       |
| `fact_sales_daily[sales_date]` | `dim_date[date_key]`      | sales_date = date_key   | Many-to-one | Single       |

### 3.3 Publish to Fabric workspace

1. **File > Publish to Power BI**
2. Select your Fabric workspace
3. The semantic model appears in the workspace as a Direct Lake dataset

> **GCP comparison:** In Looker, the explore definition and joins are defined in LookML code and version-controlled. In Power BI, relationships are defined visually in Model View or programmatically via TMDL/XMLA. Power BI now supports Git integration for version-controlling the model definition.

---

## Step 4: Convert LookML expressions to DAX

### 4.1 Measure conversion reference

| LookML measure                                                    | DAX equivalent                                                                                                    | Notes                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `type: sum; sql: ${TABLE}.amount`                                 | `Total Amount = SUM(table[amount])`                                                                               | Direct mapping                               |
| `type: count`                                                     | `Row Count = COUNTROWS(table)`                                                                                    | Count of rows in the table                   |
| `type: count_distinct; sql: ${TABLE}.customer_id`                 | `Unique Customers = DISTINCTCOUNT(table[customer_id])`                                                            | Direct mapping                               |
| `type: average; sql: ${TABLE}.amount`                             | `Avg Amount = AVERAGE(table[amount])`                                                                             | Direct mapping                               |
| `type: min; sql: ${TABLE}.date_col`                               | `First Date = MIN(table[date_col])`                                                                               | Direct mapping                               |
| `type: max; sql: ${TABLE}.date_col`                               | `Last Date = MAX(table[date_col])`                                                                                | Direct mapping                               |
| `type: number; sql: ${total_revenue} / NULLIF(${total_units}, 0)` | `Revenue Per Unit = DIVIDE([Total Revenue], [Total Units], 0)`                                                    | Use `DIVIDE` for safe division               |
| `type: yesno; sql: ${TABLE}.is_active = 1`                        | Calculated column: `Is Active = table[is_active] = 1`                                                             | Boolean column                               |
| `type: sum; sql: CASE WHEN ... THEN ... END`                      | `Conditional Sum = SUMX(table, IF(condition, value, 0))`                                                          | Use `SUMX` + `IF` for conditional            |
| `type: percent_of_total`                                          | `Pct of Total = DIVIDE([Measure], CALCULATE([Measure], REMOVEFILTERS()))`                                         | Use `REMOVEFILTERS` for grand total          |
| `type: running_total; sql: ${TABLE}.amount`                       | `Running Total = CALCULATE([Total Amount], FILTER(ALL(dim_date), dim_date[date_key] <= MAX(dim_date[date_key])))` | Running total with date filter               |
| `type: list; sql: ${TABLE}.name`                                  | `Name List = CONCATENATEX(table, table[name], ", ")`                                                              | String aggregation                           |
| Filtered measure with `filters: [dim.field: "value"]`             | `Filtered Measure = CALCULATE([Base Measure], table[field] = "value")`                                            | Use `CALCULATE` with filter                  |
| `html: <a href="...">`                                            | Conditional formatting or URL column                                                                              | Power BI handles formatting via UX, not HTML |
| `drill_fields: [...]`                                             | Drillthrough page or tooltip page                                                                                 | Configure in report design                   |

### 4.2 Common LookML patterns and DAX equivalents

**Period-over-period comparison:**

```lookml
# LookML
measure: revenue_prior_year {
  type: sum
  sql: ${TABLE}.gross_amount ;;
  filters: [dim_date.fiscal_year: "{% date_start prior_year %}"]
}
```

```dax
// DAX
Revenue Prior Year =
CALCULATE(
    [Gross Revenue],
    SAMEPERIODLASTYEAR(dim_date[date_key])
)
```

**Cumulative metric:**

```lookml
# LookML
measure: cumulative_revenue {
  type: running_total
  sql: ${total_revenue} ;;
  direction: "column"
}
```

```dax
// DAX
Cumulative Revenue =
CALCULATE(
    [Gross Revenue],
    FILTER(
        ALL(dim_date[date_key]),
        dim_date[date_key] <= MAX(dim_date[date_key])
    )
)
```

**Percentage of filtered total:**

```lookml
# LookML
measure: pct_of_region_total {
  type: percent_of_total
  sql: ${total_revenue} ;;
  direction: "column"
}
```

```dax
// DAX
Pct of Region Total =
DIVIDE(
    [Gross Revenue],
    CALCULATE([Gross Revenue], REMOVEFILTERS(fact_sales_daily[product_id])),
    0
)
```

---

## Step 5: Rebuild dashboards in Power BI

### 5.1 Map Looker tile types to Power BI visuals

| Looker tile type        | Power BI visual          | Notes                                                |
| ----------------------- | ------------------------ | ---------------------------------------------------- |
| Single value            | Card                     | Use card visual for KPI callouts                     |
| Table                   | Table or Matrix          | Matrix for pivoted tables                            |
| Bar chart               | Clustered bar chart      | Horizontal or vertical                               |
| Line chart              | Line chart               | Identical concept                                    |
| Area chart              | Area chart               | Identical concept                                    |
| Scatter plot            | Scatter chart            | Identical concept                                    |
| Map (choropleth)        | Filled map or Azure Maps | Use Azure Maps for GovCloud                          |
| Pie / donut             | Donut chart              | Pie charts are available but donut preferred         |
| Funnel                  | Funnel chart             | Identical concept                                    |
| Pivot table             | Matrix                   | Matrix with row/column groups replaces Looker pivots |
| Text tile               | Text box                 | Use rich text box for narrative                      |
| LookML dashboard filter | Report slicer            | Slicer visual or filter pane                         |

### 5.2 Create report pages

For each Looker dashboard, create a Power BI report with one or more pages:

1. Open Power BI Desktop connected to the published semantic model
2. For each Looker dashboard, create a new report page
3. Rebuild each tile using the visual mapping above
4. Apply the DAX measures created in Step 4
5. Add slicers for any Looker dashboard filters

### 5.3 Apply consistent formatting

- Use the organization theme (`.json` theme file) for consistent branding
- Set default date formatting to match Looker output
- Configure tooltips with detail measures

---

## Step 6: Configure row-level security

### 6.1 Map Looker access filters to DAX RLS

Looker uses `access_filter` on explores with `user_attribute_param`:

```lookml
# LookML
explore: sales_explore {
  access_filter: {
    field: dim_region.region_code
    user_attribute: allowed_regions
  }
}
```

In Power BI, create an RLS role:

1. Open the semantic model in Power BI Desktop
2. **Modeling > Manage roles > New role**
3. Name: `Region Restricted`
4. Add a DAX filter on `dim_region`:

```dax
[region_code] IN
SELECTCOLUMNS(
    FILTER(
        'SecurityTable',
        'SecurityTable'[user_email] = USERPRINCIPALNAME()
    ),
    "region", 'SecurityTable'[allowed_region]
)
```

### 6.2 Create a security mapping table

Create a table mapping Entra ID users to allowed regions:

| user_email        | allowed_region                 |
| ----------------- | ------------------------------ |
| analyst1@acme.gov | US-EAST                        |
| analyst1@acme.gov | US-WEST                        |
| analyst2@acme.gov | US-EAST                        |
| manager@acme.gov  | (all regions - no restriction) |

### 6.3 Assign roles to Entra ID groups

In the Fabric workspace:

1. Navigate to the semantic model settings
2. **Security > Add members**
3. Assign Entra ID security groups to RLS roles

> **GCP comparison:** Looker's `access_filter` + `user_attribute` model is more declarative than Power BI RLS. Looker automatically applies the filter to every query from the explore. Power BI requires defining DAX filter expressions per role, but the end result is equivalent. Entra ID groups replace Looker user attributes.

---

## Step 7: Set up data refresh / Direct Lake

### 7.1 Direct Lake mode (recommended)

If your semantic model connects to a Fabric lakehouse with Delta tables, Direct Lake is the default mode. It reads directly from OneLake without data import.

**Benefits:**

- No scheduled refresh needed for data (reads live Delta files)
- Automatic fallback to DirectQuery for unsupported patterns
- Semantic model metadata refresh is fast (seconds)

### 7.2 Configure semantic model refresh (metadata only)

Even with Direct Lake, schedule a metadata refresh to pick up schema changes:

1. In the Fabric workspace, select the semantic model
2. **Settings > Scheduled refresh**
3. Set frequency: Daily at 03:00 UTC (after dbt runs at 02:00)

### 7.3 Set up Power BI subscriptions (replaces Looker schedules)

For each Looker scheduled delivery, create a Power BI subscription:

1. Open the report in Power BI Service
2. **Subscribe to report** (envelope icon)
3. Configure recipients, frequency, and format (PDF or PNG attachment)

| Looker schedule feature            | Power BI subscription equivalent  |
| ---------------------------------- | --------------------------------- |
| Email with inline content          | Email with report snapshot        |
| PDF attachment                     | PDF attachment (via subscription) |
| CSV export                         | Export via Power Automate flow    |
| Webhook delivery                   | Power Automate HTTP action        |
| Conditional send (if data matches) | Data Activator alert trigger      |
| Slack/Teams delivery               | Power Automate Teams connector    |

---

## Step 8: Validate with users

### 8.1 Side-by-side comparison

Run both Looker and Power BI in parallel for 2 weeks:

1. Select 3-5 power users per dashboard
2. Ask them to perform their daily workflows in both tools
3. Compare numbers across both platforms
4. Document any discrepancies

### 8.2 Validation checklist

- [ ] All measures produce identical values (within 0.01% tolerance for floating-point)
- [ ] Dashboard filter behavior matches (slicers replace Looker filters)
- [ ] Row-level security restricts data correctly per user
- [ ] Subscriptions deliver on schedule
- [ ] Drill-through navigation works as expected
- [ ] Performance is acceptable (dashboard load < 5 seconds)
- [ ] Mobile view is functional for field users

### 8.3 User training

Conduct 2-3 training sessions covering:

- Power BI report navigation (vs. Looker Explore)
- Using slicers and filters (vs. Looker dashboard filters)
- Power BI Q&A and Copilot (vs. Looker Explore ad-hoc)
- Self-service report creation (vs. Looker self-service Explore)
- Exporting data (vs. Looker download options)

---

## LookML to DAX conversion quick reference

| LookML expression                  | DAX equivalent                                                         |
| ---------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| `${TABLE}.column`                  | `table[column]`                                                        |
| `${view_name.field_name}`          | `RELATED(table[column])` (if across relationship)                      |
| `type: sum`                        | `SUM(table[col])`                                                      |
| `type: count`                      | `COUNTROWS(table)`                                                     |
| `type: count_distinct`             | `DISTINCTCOUNT(table[col])`                                            |
| `type: average`                    | `AVERAGE(table[col])`                                                  |
| `type: median`                     | `MEDIAN(table[col])`                                                   |
| `type: min`                        | `MIN(table[col])`                                                      |
| `type: max`                        | `MAX(table[col])`                                                      |
| `type: number` (calculated)        | Use `CALCULATE`, `DIVIDE`, etc.                                        |
| `type: percent_of_total`           | `DIVIDE([Measure], CALCULATE([Measure], REMOVEFILTERS()))`             |
| `type: running_total`              | `CALCULATE([Measure], FILTER(ALL(date), date[col] <= MAX(date[col])))` |
| `type: list`                       | `CONCATENATEX(table, table[col], ", ")`                                |
| `type: yesno`                      | `IF(condition, TRUE(), FALSE())`                                       |
| `sql_where: ${dim.col} = 'X'`      | `CALCULATE([Measure], table[col] = "X")`                               |
| `NULLIF(a, 0)`                     | `IF(a = 0, BLANK(), a)`                                                |
| `COALESCE(a, b)`                   | `COALESCE(a, b)` (DAX supports this)                                   |
| `CONCAT(a, ' ', b)`                | `a & " " & b`                                                          |
| `CASE WHEN ... THEN ... END`       | `SWITCH(TRUE(), condition1, val1, condition2, val2, default)`          |
| Liquid parameter `{% parameter %}` | Power BI parameter or slicer                                           | Liquid logic ports to What-If parameters |
| Liquid condition `{% if ... %}`    | `IF()` / `SWITCH()` in DAX                                             | Conditional logic in measures            |

---

## Next steps

After completing this tutorial:

1. **Migrate remaining LookML projects.** Apply the same model-explore-dashboard pattern to each Looker project.
2. **Enable Copilot.** Configure Copilot for Power BI on the semantic model to give users a natural-language query surface replacing Looker Explore.
3. **Set up deployment pipelines.** Use Fabric deployment pipelines (dev > test > prod) to version-control the semantic model, replacing Looker's LookML CI/CD.
4. **Review the playbook.** See [GCP to Azure Migration Playbook](../gcp-to-azure.md) for the full phased plan.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Playbook](../gcp-to-azure.md) | [BigQuery to Fabric Tutorial](tutorial-bigquery-to-fabric.md) | [Benchmarks](benchmarks.md) | [Best Practices](best-practices.md)
