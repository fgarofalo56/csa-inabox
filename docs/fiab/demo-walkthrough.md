# CSA Loom — Live Demo Walkthrough (Commercial)

**Environment:** `https://csa-loom.limitlessdata.ai` — sign in with your admin account.

**What's pre-seeded for you (all owned by your admin identity, so you can open everything):**
a set of **`Demo — …` workspaces**, each installed from a one-click use-case app
that **provisions and seeds a real Azure backend** — not empty shells. The
flagship **`Demo — Direct Lake`** workspace runs the full medallion → Direct Lake
→ semantic model → report story end-to-end, with **real rows already seeded**
(`gold.fact_sales` etc. are queryable the moment you open the lakehouse).

**The one-line pitch:** *CSA Loom is a Microsoft Fabric-parity data platform that
runs entirely on Azure-native services (Synapse, ADX, Databricks, Event Hubs,
Purview, Azure ML) — no Fabric capacity required — and works day-one in both
Commercial and Government clouds.*

---

## The demo workspaces (all real, all navigable)

| Workspace | What it shows | Backend (real) |
|-----------|---------------|----------------|
| **Demo — Direct Lake** ⭐ | Medallion lakehouse → Direct-Lake semantic model → report + real-time refresh (the hero) | ADLS Gen2 Delta + Synapse serverless + Databricks; **seeded rows** |
| **Demo — Medallion Bronze / Silver / Gold** | The medallion transform notebooks (bronze→silver→gold), by industry | Databricks / Synapse Spark |
| **Demo — Lakehouse Inspector** | Browse Delta tables, files, history, maintenance | ADLS Gen2 + serverless SQL |
| **Demo — Real-Time Dashboards** | Eventstream → Eventhouse → real-time KQL dashboard | Azure Data Explorer + Event Hubs |
| **Demo — IoT Real-Time** | IoT telemetry ingestion + streaming analytics | Event Hubs + Stream Analytics + ADX |
| **Demo — ML Pipeline** | Train → register → score a model | Azure ML / MLflow |
| **Demo — RAG Builder** | Grounded RAG flow over your data | AI Foundry + AI Search |
| **Demo — Sovereign AI Agents** | Data agents / Copilot agents | AOAI + agent runtime |
| **Demo — Data Governance** | Purview data products, glossary, classifications | Microsoft Purview |
| **Demo — Data Steward** | Data quality + master-data management | Purview + Synapse |
| **Demo — Federal Data Mesh** | Domains + a fully-working data product with contracts | Cosmos + Purview + Delta Sharing |
| **Demo — FinOps** | Per-workspace cost attribution across subscriptions | Azure Cost Management |

> If an item is still finishing its first provision, it shows **"provisioning"** —
> never a "not bound" gate. The seeded data (lakehouse tables, governed items,
> cost data) is present immediately.

---

## Suggested flow (~18–22 min)

### 1. Home + the shape of the product (1 min)
- Land on **Home**. Point out the left nav grouped by lifecycle: **Data** (OneLake
  catalog, Marketplace, Connections) → **Build** (Real-Time Intelligence, Data
  Science, Orchestration, Deployment) → **Analyze** (Lineage, Monitor, Reports) →
  **Govern** (Governance).
- **Say:** "Same information architecture as Fabric — but every backend is Azure-native."

### 2. Create → the full item catalog (2 min)
- Click **Create** (top-left). Show the **New item** gallery: **124 item types**
  across families — Data Engineering (lakehouse, warehouse, notebook, pipeline,
  dataflow, **batch pool**, mirrored DB), Real-Time Intelligence (eventstream,
  eventhouse, KQL DB/dashboard, Activator), Data Science (ML model, experiment,
  data agent, AutoML), Databases (SQL, Cosmos, Postgres), Power BI (semantic
  model, report, dashboard, paginated, scorecard), and more.
- **Say:** "Feature-for-feature parity with Fabric's item types, plus Azure-native
  items Fabric doesn't have. This is the breadth."

### 3. ⭐ The hero: **Demo — Direct Lake** (6–7 min) — the end-to-end architecture
Open **Workspaces → Demo — Direct Lake**. It contains **11 real, provisioned items**
that make up a complete medallion → Direct Lake → report solution — walk them
top-to-bottom as the *architecture of the pattern*:
- **Legacy Sales OLTP Mirror (Bronze)** — mirrored-database item (ADF-CDC → Bronze Delta).
- **Direct-Lake-Replacement Lakehouse** — ADLS Gen2 Bronze/Silver/Gold medallion.
  The lakehouse was **seeded at install** — the Gold `fact_sales` / dim tables hold
  real sample rows (queryable via the serverless SQL endpoint in the `loom_lakehouse`
  database). Show the Bronze/Silver/Gold folder structure.
- **Silver — Cleanse & Conform** and **Gold — Star Schema (partitioned)** — the two
  Databricks notebooks that build the medallion (real PySpark). Show the compute
  selector: **`loompool (Synapse Spark) · Available`** + Databricks cluster tiers
  (`loom-cluster-s/m/l`). *"Warm compute — a cell runs against a live session, no cold-start."*
- **Sales Analytics (Premium Import)** — the **semantic model**: measures/DAX
  (`Total Sales`, `Margin %`, `Sales YoY %`), relationships, and **Direct Lake**
  storage mode (reads the Gold Delta live — Fabric-parity, no Fabric).
- **Sales Analytics Report** — the **report designer**, and it **renders real values
  right now**: an *Executive Overview* page with cards **Total Revenue ($4,290.28),
  Total Margin ($1,873.42), Units Sold (25)**, a **Revenue by Month** column chart, a
  **Margin by Month** donut, and a **Monthly Detail** table (8 rows) — all computed live
  over the seeded medallion Gold data (Azure-native, no Power BI/Fabric workspace). Show
  **Get data → Use a Loom item** to bind a report straight to a Loom lakehouse. For the
  *integrated* Power BI story, **Weave → Build Power BI model** publishes to a real
  Power BI workspace.
- **Gold Commit → Shim Eventstream** + **Direct-Lake-Shim Refresh Pipeline** +
  **Shim Freshness Watchdog** — the real-time refresh arc: every Gold commit fires an
  Event Grid event → the pipeline runs a partition refresh → the Activator alerts on
  an SLA breach. *"Direct-Lake-like 5–30 s freshness on Azure-native services."*

> Every **`Demo — …`** workspace's report renders the same real-data pattern (Total
> Revenue/Margin/Units + Revenue by Month) over live seeded medallion data — open any
> of them and the visuals show values immediately. The **Governance, FinOps/Chargeback,
> Marketplace, and Admin health** surfaces (sections 5, 6, 8) are the other always-live
> "it's real" beats.

### 4. Real-Time Intelligence (2 min)
Open **Demo — Real-Time Dashboards**, then left nav → **Real-Time Intelligence → Streams**.
- **Say:** "Banner says it explicitly — *no Microsoft Fabric capacity required*." Show the
  **27 Azure-native source connectors** (Event Hubs, IoT Hub, Service Bus,
  SQL/Cosmos/Postgres/Mongo/Oracle CDC, Kafka, Kinesis, Pub/Sub).
- Open the **real-time KQL dashboard** — tiles query **Azure Data Explorer** live.

### 5. Governance — the sovereignty story (3 min)
Open **Demo — Data Governance** and **Demo — Data Steward**, then left nav → **Governance**.
- **Connected to Microsoft Purview — live.** Show governed items, **classification /
  sensitivity tagging**, **glossary terms**, and **lineage**.
- **DLP** — show the enabled DLP policy library (9 presets) applying to data products.
- **Data quality + MDM** (Data Steward) — rules, golden-record / SCD-type-2 patterns.
- **Say:** "Real Purview Data Map + Unity Catalog + OneLake catalog sync — governance
  is Azure-native and live from day one, which is the sovereignty story for Gov."

### 6. Data mesh + a working data product (2 min)
Open **Demo — Federal Data Mesh**.
- Show **domains**, a **data product** with a **contract**, and **Delta Sharing** to a
  downstream consumer. Tie it to the **Marketplace** (left nav → Data / API marketplace)
  where products/APIs are published and subscribed.

### 7. AI — agents + Copilot (2 min)
Open **Demo — RAG Builder** / **Demo — Sovereign AI Agents**, then the top **Copilot**.
- Show the **grounded RAG flow** and a **data agent**.
- Ask **Copilot** something about the workspace ("summarize the items in Demo — Direct
  Lake" / "how do I build a medallion lakehouse"). It grounds on live Loom context.

### 8. Admin / platform health — the "it's real" close (2 min)
Top-right **⚙ Settings → Admin**:
- **Health & Self-audit → 100**. **Runtime config → 73 / 73** configured.
- **Scaling** → per-SKU scaling of Synapse / Databricks / SQL.
- **Usage & Chargeback** → real Azure Cost Management spend, per-workspace attribution
  across every subscription (open **Demo — FinOps** for the per-workspace view).
- **MCP servers** → Microsoft + gov-safe MCP servers enabled by default.
- **Say:** "Everything is real, wired to real Azure backends, and default-on — nothing is a mock."

---

## Talking points / differentiators
- **No Fabric dependency:** every item works 100% Azure-native by default; Fabric/Power BI
  is strictly opt-in. This is the sovereignty story for Gov.
- **Both clouds, day-one:** the same product runs in Commercial and Azure Government (GCC-High).
- **Real compute, warm:** multi-size Synapse Spark pools + Databricks clusters, pre-warmed
  so notebooks are instant.
- **Bound + seeded + rendering:** the demo workspaces are provisioned with real Azure
  backends, the lakehouses are seeded with real rows, and every report **renders those
  rows live** (Total Revenue/Margin/Units + Revenue by Month). Governance, FinOps,
  Marketplace and Admin also show live values — click anything and it shows data, not a gate.
- **Weave:** turn any Loom item into a Power BI model / API / lineage graph with one click.
- **Fabric parity + more:** Direct Lake, mirroring, OneLake catalog, semantic models —
  plus Azure-native items and a Palantir-style ontology layer.

---

## The Gov twin — apples-to-apples (2–3 min)

The **same product, same code, same demo** runs in **Azure Government**:
`https://loom-console-dcmt6cqoezlgs-agg6h9e5cjamh5h2.z01.azurefd.us`

- **Same 15 demo workspaces** (CSA Loom Demo + the `Demo — …` verticals), seeded
  the same way, backed by a **real Gov data landing zone** deployed today:
  Synapse (+ 3 Spark pools + dedicated SQL pool), medallion lake (ADLS Gen2
  bronze/silver/gold), Databricks, Event Hubs, Service Bus, Cosmos, Event Grid —
  all behind private endpoints in a Gov VNet.
- **Governance reuses the tenant's existing Purview** (`dmlz-dev-purview001`) —
  the brownfield story in action.
- **Say:** "This is the sovereignty close: identical experience, identical code,
  Commercial and GCC-High, deployed with the same one-button path — and no
  Microsoft Fabric dependency in either cloud."

## Honest notes (if asked "what's not done")
- A few app verticals expose **honest infra-gates** where a specific one-time Azure grant
  is still needed (e.g. Databricks mirror source connection) — these name the exact env
  var / role rather than failing silently. The **lakehouse seed + report render** path
  needs none of that and shows real values out of the box.
- Gov: data-plane role grants were deferred at deploy (`skipRoleGrants`) — some Gov
  data-plane calls need a one-time admin grant pass; the structure/navigation demo is
  unaffected.
- UX polish is an ongoing sweep to meet/exceed the Fabric visual bar on every surface.
