# Direct Lake-Replacement Pattern

Customers migrating from Tableau / Qlik / on-prem Power BI Report
Server use the CSA Loom **Direct-Lake-Shim warm-cache materializer
pattern** to get Power BI Premium semantic models with framed-like
freshness (5-30 s) — without waiting for Fabric Gov GA.

## When this pattern fits

- Customer has aging on-prem BI server (Tableau Server / Qlik Sense
  / Power BI Report Server)
- Customer wants to modernize to Power BI cloud + lakehouse
- Customer's audit boundary blocks Fabric / Direct Lake
- Customer has Power BI Premium F-SKU (GCC-H / IL5) or P-SKU (GCC;
  no Direct Lake parity available)
- Workload characteristics: aggregate analytics + interactive
  dashboards; not sub-second-required

## Architecture

```
   Operational sources                Loom lakehouse                  BI surface
   (DB / files / streams)             (ADLS Gen2)                     (Power BI Premium)
                                                                       ┌──────────────────┐
   ┌─────────┐                       ┌──────────────────┐              │ Semantic Model   │
   │ DB      │                       │ Bronze table     │              │ (Premium Import) │
   │ Files   │ ──Loom Mirroring──►   │ Silver table     │ ──refresh──► │ Authored in TMDL │
   │ Streams │                       │ Gold table       │              │ Deployed via TOM │
   └─────────┘                       └────────┬─────────┘              └────────┬─────────┘
                                              │ commit event                    │
                                              ▼                                  ▼
                              ┌──────────────────────────────┐         ┌──────────────────┐
                              │ Storage Event Grid           │         │ Power BI Reports │
                              │ → Loom Direct-Lake-Shim      │         │ (refresh on      │
                              │ → TOM partition refresh      │         │  every model     │
                              │   on Power BI Premium model  │         │  refresh)        │
                              └──────────────────────────────┘         └──────────────────┘
```

## Migration playbook

### Step 1 — Inventory the source BI estate

- Catalogue all Tableau workbooks / Qlik apps / on-prem PBI reports
- Identify primary data sources (databases, files, cubes)
- Map dashboards to underlying data models
- Prioritize: top 20% of dashboards cover 80% of usage

### Step 2 — Stand up Loom

Per [Quick Start](../deployment/quickstart.md).

### Step 3 — Migrate sources to Bronze

For each source:
- Database sources → Loom Mirroring Engine (Debezium / Cosmos
  connector)
- File sources → Azure Data Factory copy → ADLS Gen2 Bronze
- Stream sources → Azure Stream Analytics → ADX (cross-engine to
  Bronze if needed)

### Step 4 — Build Silver + Gold via Databricks notebooks

- Cleanse + conform in Silver
- Business semantics + star schemas in Gold
- Partition Gold tables by date (or appropriate dimension) so
  partition-refresh works

### Step 5 — Re-author semantic models in Power BI Desktop

For each priority dashboard:
- Open original (Tableau / Qlik / PBI Report Server)
- Re-author the semantic model in Power BI Desktop targeting the
  Gold tables
- Use TMDL format (Power BI Project / .pbip)
- Commit `.pbip` to Git

### Step 6 — Configure Direct-Lake-Shim refresh policy

Per [Tutorial 03](../tutorials/03-direct-lake-parity.md):

```bash
loom-dl-shim configure \
  --semantic-model <model-id> \
  --table <gold-table-name> \
  --refresh-policy partition \
  --partition-column date
```

### Step 7 — Build Power BI reports

- Re-create dashboards in Power BI Desktop against the new semantic
  models
- Publish to Power BI Premium workspace
- Verify visual parity with original

### Step 8 — Cutover

- Open new Power BI report URLs to a pilot user group
- Validate report performance + freshness (5-30 s should be
  acceptable for most analytical workloads)
- Migrate users in cohorts
- Decommission original BI server after parallel-run period

## Expected outcomes

- Self-service Power BI authoring (vs centralized Tableau / Qlik
  admin model)
- 5-30 s freshness on partition-refresh (vs daily / hourly on legacy
  BI servers)
- Modern data lake foundation (Loom lakehouse) supports additional
  workloads beyond BI
- When Fabric Gov GA arrives: re-author semantic models for native
  Direct Lake on OneLake → sub-second freshness without rewriting
  the underlying analytics

## Cost comparison (typical)

| Item | Legacy on-prem BI server | Loom + Power BI Premium |
|---|---|---|
| BI server licenses | $$$$ annual | $0 (Power BI Premium consumption) |
| Server hardware + maintenance | $$$ annual | $0 (cloud-managed) |
| Storage | $$ annual | $$$ (Azure ADLS Gen2 + Power BI workspace storage) |
| Compute (ETL) | $$$ annual | $$ (Databricks DBU usage-based) |
| Refresh latency | hours to nightly | 5-30 seconds |
| Self-service authoring | Limited | Yes (Power BI Desktop) |

Typical net savings: 40-60% TCO + step-function improvement in
freshness + self-service.

## Honest gap

This pattern delivers **5-30 second freshness**. Fabric's native
Direct Lake gives sub-second. For workloads requiring sub-second:
- Wait for Fabric Gov GA
- Or use Databricks SQL Warehouse + DirectQuery (Commercial only;
  always live but slower DAX engine)
- Or use Power BI DirectQuery against Synapse Serverless (slower
  per-query)

For most analytical workloads (monthly / quarterly / yearly aggregates
+ daily refresh), 5-30 s is **better than what the legacy BI server
delivered** and acceptable for the user's experience.

## Related

- [Direct Lake parity workload](../workloads/direct-lake-parity.md)
- [Direct-Lake Shim service](../services/direct-lake-shim.md)
- [Tutorial 03 — Direct Lake parity](../tutorials/03-direct-lake-parity.md)
- Existing migration: [Tableau to Power BI migration](../../migrations/tableau-to-powerbi/index.md)
