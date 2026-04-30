# Analytics Migration: QuickSight to Power BI

**A deep-dive guide for BI analysts and data engineers migrating Amazon QuickSight dashboards, datasets, and analytics workflows to Microsoft Power BI.**

---

## Executive summary

Amazon QuickSight is a capable BI tool, but its market share in federal environments is a fraction of Power BI's. Most federal agencies already have Power BI licenses through their Microsoft 365 Enterprise Agreement, and most analysts already know Power BI. Migrating from QuickSight to Power BI eliminates an integration seam between the analytics platform and the Microsoft productivity suite that federal workers live in daily.

There is no automated migration tool from QuickSight to Power BI. Dashboard migration is a manual rebuild process. However, the underlying data model, calculated fields, parameters, and row-level security all have direct Power BI equivalents. This guide provides the mapping for each component and worked examples for common patterns.

---

## Component mapping

| QuickSight concept | Power BI equivalent | Migration complexity | Notes |
|---|---|---|---|
| Analysis | Power BI report | M | Manual rebuild; visual-by-visual |
| Dashboard (published) | Power BI dashboard / report | M | Dashboards in Power BI pin visuals from reports |
| Dataset | Semantic model (dataset) | S-M | Rebuild connections and relationships |
| SPICE dataset | Import mode dataset | S | Data import from source |
| Direct Query dataset | DirectQuery or Direct Lake | S | Direct Lake preferred for Delta tables |
| Calculated field | DAX measure or calculated column | M | DAX learning curve for QuickSight users |
| Parameter | Power BI parameter / slicer | S | Multiple implementation options |
| Filter | Report/page/visual filter | XS | Direct mapping |
| Row-level security (RLS) | Power BI RLS (DAX) + Entra ID | S | Dynamic RLS via Entra groups |
| QuickSight Q | Power BI Copilot | S | GPT-4 powered; richer NL interaction |
| Embedding (anonymous) | Power BI Embedded (App-owns-data) | M | Azure AD app registration required |
| Embedding (authenticated) | Power BI Embedded (User-owns-data) | S | Entra ID SSO |
| Threshold alerts | Data Activator / Power Automate alerts | S | Richer alerting with Power Automate |
| Email reports (scheduled) | Power BI subscriptions | XS | Direct equivalent |
| Paginated reports | Power BI paginated reports (SSRS) | M | Pixel-perfect reporting; RDLC format |

---

## Data source connection migration

### QuickSight data sources to Power BI connections

| QuickSight data source | Power BI connection | Connection mode |
|---|---|---|
| Amazon Redshift | Databricks SQL endpoint (post-migration) | DirectQuery or Direct Lake |
| Amazon S3 (SPICE import) | ADLS Gen2 / OneLake (post-migration) | Direct Lake |
| Amazon Athena | Databricks SQL endpoint (post-migration) | DirectQuery |
| Amazon RDS (PostgreSQL/MySQL) | Azure Database for PostgreSQL/MySQL | DirectQuery |
| Amazon Aurora | Azure SQL Database | DirectQuery |
| Uploaded CSV/Excel | OneLake / SharePoint | Import |
| Custom SQL (SPICE) | Databricks SQL view or dbt model | Direct Lake |

### Direct Lake mode (recommended)

Direct Lake is the recommended connection mode for data already in Delta Lake format on ADLS Gen2 or OneLake. It provides:

- Sub-second query performance over Delta tables
- No data import or refresh cycle needed
- Automatic column-level caching
- Reduced Fabric capacity consumption vs Import mode

```
Delta Lake table (ADLS Gen2 / OneLake)
    └── Fabric Lakehouse SQL endpoint
          └── Power BI Direct Lake semantic model
                └── Power BI report
```

**Configuration:**
1. Create a Fabric Lakehouse (or connect existing ADLS Gen2 storage).
2. Ensure Delta tables are registered in the Lakehouse.
3. In Power BI Desktop, connect to the Lakehouse SQL endpoint.
4. Select Direct Lake as the storage mode.
5. Build relationships and DAX measures in the semantic model.

---

## SPICE to Import mode and Direct Lake

### SPICE overview (QuickSight)

SPICE (Super-fast, Parallel, In-memory Calculation Engine) is QuickSight's in-memory data store. Data is imported from source systems into SPICE on a schedule. SPICE has a per-user capacity (10 GB default for Enterprise, purchasable in 500 GB increments).

### Power BI equivalents

| SPICE capability | Power BI Import mode | Power BI Direct Lake |
|---|---|---|
| In-memory storage | Yes (VertiPaq engine) | Yes (column cache from Delta) |
| Scheduled refresh | Yes (up to 48/day Pro; 48/day PPU) | Automatic (reads Delta directly) |
| Incremental refresh | Yes (Premium/PPU) | Automatic |
| Capacity limit | 1 GB (Pro) / 100 GB (PPU) / 400 GB (Premium) | OneLake storage (no model size limit) |
| Query performance | Fast (fully in-memory) | Fast (selective column loading) |
| Data freshness | Depends on refresh schedule | Near real-time (reads latest Delta version) |

**Recommendation:** Use Direct Lake for all new semantic models. Use Import mode only for data sources that are not in Delta Lake format.

---

## Calculated fields to DAX measures

### Common translations

| QuickSight calculated field | DAX equivalent | Notes |
|---|---|---|
| `sum(quantity)` | `Total Units = SUM('Orders'[quantity])` | Explicit measure definition |
| `count(distinct customer_id)` | `Unique Customers = DISTINCTCOUNT('Orders'[customer_id])` | Function name differs |
| `avg(amount)` | `Avg Amount = AVERAGE('Orders'[amount])` | Same concept |
| `sum(amount) / sum(quantity)` | `Price Per Unit = DIVIDE(SUM('Orders'[amount]), SUM('Orders'[quantity]))` | DIVIDE handles division by zero |
| `ifelse(region="EAST", "Eastern", "Other")` | `Region Label = IF('Orders'[region] = "EAST", "Eastern", "Other")` | IF instead of ifelse |
| `dateDiff(order_date, ship_date, "DAY")` | `Days to Ship = DATEDIFF('Orders'[order_date], 'Orders'[ship_date], DAY)` | Same function name in DAX |
| `percentOfTotal(sum(amount))` | `Pct of Total = DIVIDE(SUM('Orders'[amount]), CALCULATE(SUM('Orders'[amount]), ALL('Orders')))` | Requires CALCULATE + ALL |
| `runningTotal(sum(amount), order_date)` | Uses a combination of CALCULATE and FILTER | More complex in DAX |
| `periodOverPeriod(sum(amount), order_date, MONTH, -1)` | `MoM Change = [Total Revenue] - CALCULATE([Total Revenue], DATEADD('Calendar'[Date], -1, MONTH))` | Time intelligence in DAX |
| `decimalFormat(amount, "#,##0.00")` | Format string in visual or `FORMAT(amount, "#,##0.00")` | Applied at visual level |

### DAX patterns for common QuickSight calculations

**Year-over-year comparison:**

```dax
// QuickSight: periodOverPeriod(sum(amount), order_date, YEAR, -1)
YoY Revenue Change =
VAR CurrentRevenue = [Total Revenue]
VAR PriorYearRevenue =
    CALCULATE(
        [Total Revenue],
        DATEADD('Calendar'[Date], -1, YEAR)
    )
RETURN
    DIVIDE(CurrentRevenue - PriorYearRevenue, PriorYearRevenue)
```

**Running total:**

```dax
// QuickSight: runningTotal(sum(amount), order_date, ASC)
Running Total Revenue =
CALCULATE(
    [Total Revenue],
    FILTER(
        ALL('Calendar'[Date]),
        'Calendar'[Date] <= MAX('Calendar'[Date])
    )
)
```

**Top N filter:**

```dax
// QuickSight: topBottomFilter with rank
Top 10 Products =
CALCULATE(
    [Total Revenue],
    TOPN(10, ALL('Products'), [Total Revenue], DESC)
)
```

---

## Parameters to Power BI slicers and parameters

### QuickSight parameter types and Power BI equivalents

| QuickSight parameter | Power BI equivalent | Implementation |
|---|---|---|
| String parameter | Slicer (dropdown) | Add a slicer visual bound to the column |
| Integer parameter | Slicer (numeric range) or What-if parameter | What-if for calculated scenarios |
| Date parameter | Date slicer | Relative date slicer or calendar slicer |
| Cascading parameters | Cascading slicers | Use relationship-based filtering |
| Dynamic default | Default slicer value | Set in report settings |
| URL parameter | Bookmark + URL filter | `?filter=Table/Column eq 'value'` |

### What-if parameter example (replacing QuickSight parameter controls)

```
-- In Power BI Desktop:
-- 1. Modeling tab > New Parameter > What-if
-- 2. Configure: Discount Rate, 0% to 50%, increment 1%
-- 3. Creates a calculated table + measure:

Discount Rate = GENERATESERIES(0, 0.5, 0.01)
Discount Rate Value = SELECTEDVALUE('Discount Rate'[Discount Rate], 0)

-- Use in measures:
Discounted Revenue =
    [Total Revenue] * (1 - [Discount Rate Value])
```

---

## Row-level security mapping

### QuickSight RLS

QuickSight RLS is dataset-based. You upload a CSV or create a query that maps users/groups to dimension values:

```csv
UserName,Region
user1@agency.gov,EAST
user2@agency.gov,WEST
group:analysts,EAST
group:analysts,WEST
```

### Power BI RLS

Power BI RLS uses DAX expressions that filter rows based on the signed-in user's identity:

**Step 1: Create role in Power BI Desktop**

```dax
-- Role: RegionFiltered
-- Table: Orders
-- DAX filter expression:
[region] = LOOKUPVALUE(
    'UserRegionMapping'[Region],
    'UserRegionMapping'[UserPrincipalName],
    USERPRINCIPALNAME()
)
```

**Step 2: Dynamic RLS with Entra ID groups (recommended)**

```dax
-- Role: DynamicRegion
-- Table: Orders
-- DAX filter:
VAR CurrentUser = USERPRINCIPALNAME()
VAR UserRegions =
    FILTER(
        'SecurityMapping',
        'SecurityMapping'[UserEmail] = CurrentUser
    )
RETURN
    [region] IN SELECTCOLUMNS(UserRegions, "Region", 'SecurityMapping'[Region])
```

**Step 3: Assign Entra ID groups to the role** in the Power BI service (Workspace > Semantic model > Security).

---

## QuickSight Q to Power BI Copilot

| Capability | QuickSight Q | Power BI Copilot |
|---|---|---|
| Natural language query | Yes (ML-based NLQ) | Yes (GPT-4 powered) |
| Suggested questions | Yes | Yes |
| Answer types | Visuals, KPIs, tables | Visuals, narratives, DAX, full reports |
| Custom terms/synonyms | Q Topics with synonyms | Linguistic schema + synonyms |
| Report generation | No | Yes --- Copilot creates entire report pages |
| DAX authoring | No | Yes --- Copilot writes DAX measures |
| Data summarization | Limited | Yes --- narrative summaries of data |
| Government availability | QuickSight Q in GovCloud | Copilot in GCC High (check availability) |

---

## Embedding patterns comparison

### QuickSight embedding

```javascript
// QuickSight anonymous embedding (1-click embed)
const embedUrl = `https://us-east-1.quicksight.aws.amazon.com/embed/...`;
const dashboard = QuickSightEmbedding.embedDashboard({
    url: embedUrl,
    container: '#dashboard-container',
    parameters: { region: 'EAST' }
});
```

### Power BI embedding

```javascript
// Power BI embedding (App-owns-data pattern)
const embedConfig = {
    type: 'report',
    id: reportId,
    embedUrl: embedUrl,
    accessToken: accessToken,
    tokenType: models.TokenType.Embed,
    settings: {
        filterPaneEnabled: false,
        navContentPaneEnabled: false
    }
};

const report = powerbi.embed(container, embedConfig);

// Apply filter programmatically
const filter = {
    $schema: "http://powerbi.com/product/schema#basic",
    target: { table: "Orders", column: "region" },
    operator: "In",
    values: ["EAST"]
};
report.setFilters([filter]);
```

**Key difference:** Power BI embedding integrates with Entra ID for authenticated embedding. For anonymous embedding (public-facing), Power BI Embedded uses the "App-owns-data" pattern with a service principal. QuickSight offers simpler anonymous embedding via 1-click URLs but lacks deep Microsoft ecosystem integration.

---

## Migration workflow

### Phase 1: Inventory (1 week)

1. Export all QuickSight analyses, dashboards, and datasets via the QuickSight API.
2. Document each dashboard: name, owner, data sources, refresh schedule, RLS rules, parameters, calculated fields.
3. Prioritize by usage (most-viewed dashboards first).

```bash
# List all dashboards
aws quicksight list-dashboards --aws-account-id 123456789012 --output json

# Get dashboard details
aws quicksight describe-dashboard \
  --aws-account-id 123456789012 \
  --dashboard-id dashboard-id \
  --output json
```

### Phase 2: Data model migration (2-3 weeks)

1. Ensure source data exists in Delta Lake on ADLS Gen2 (from storage/compute migration).
2. Create Power BI semantic models using Direct Lake mode.
3. Build table relationships matching the QuickSight dataset joins.
4. Convert calculated fields to DAX measures.

### Phase 3: Report rebuild (3-6 weeks)

1. Recreate each dashboard visual-by-visual in Power BI Desktop.
2. Apply formatting, color schemes, and layout to match agency branding.
3. Configure RLS roles and assign Entra ID groups.
4. Set up scheduled refresh (if using Import mode) or verify Direct Lake connectivity.

### Phase 4: Validation and rollout (2-3 weeks)

1. Dual-run: both QuickSight and Power BI serve the same dashboards for 2 weeks.
2. Validate data parity between QuickSight SPICE and Power BI Direct Lake.
3. Gather user feedback on the Power BI experience.
4. Cut over: redirect users to Power BI; disable QuickSight dashboards.

---

## Tips for QuickSight users learning Power BI

1. **Start with Power BI Desktop.** It is the primary authoring tool; the web experience is for consumption and light editing.
2. **Learn DAX incrementally.** Start with SUM, AVERAGE, COUNTROWS. Add CALCULATE and FILTER as needed. DAX is more powerful than QuickSight calculated fields but has a steeper learning curve.
3. **Use Direct Lake.** It eliminates the SPICE refresh problem entirely.
4. **Leverage Copilot.** Power BI Copilot can write DAX measures and create report pages from natural language, reducing the learning curve.
5. **Publish to workspaces.** Fabric workspaces replace QuickSight folders for organizing content and managing access.
6. **Embed in Teams.** Add Power BI reports as Teams tabs for seamless access in the collaboration tool your agency already uses.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Compute Migration](compute-migration.md) | [ETL Migration](etl-migration.md) | [Migration Playbook](../aws-to-azure.md)
