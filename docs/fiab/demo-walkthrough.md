# CSA Loom — Live Demo Walkthrough

**Environment:** `https://csa-loom.limitlessdata.ai` (Commercial). Sign in with your admin account.
**Pre-seeded for you:** a **CSA Loom Demo** workspace (11 representative items) and a **CSA Loom Demo — Apps** workspace (compound use-case apps installed). Both are owned by your admin identity, so you can open and navigate everything.

**The one-line pitch:** *CSA Loom is a Microsoft Fabric-parity data platform that runs entirely on Azure-native services (Synapse, ADX, Databricks, Event Hubs, Purview, Azure ML) — no Fabric capacity required — and works day-one in both Commercial and Government clouds.*

---

## Suggested flow (~15–20 min)

### 1. Home + the shape of the product (1 min)
- Land on **Home**. Point out the left nav grouped by lifecycle: **Data** (OneLake catalog, Marketplace, Connections) → **Build** (Real-Time Intelligence, Data Science, Orchestration, Deployment) → **Analyze** (Lineage, Monitor, Reports) → **Govern** (Governance).
- **Say:** "Same information architecture as Fabric — but every backend is Azure-native."

### 2. Create → the full item catalog (2 min)
- Click **Create** (top-left). Show the **New item** gallery: **124 item types** across families — Data Engineering (lakehouse, warehouse, notebook, pipeline, dataflow, **batch pool**, mirrored DB), Real-Time Intelligence (eventstream, eventhouse, KQL DB/dashboard, Activator), Data Science (ML model, experiment, data agent, AutoML), Databases (SQL, Cosmos, Postgres), Power BI (semantic model, report, dashboard, paginated, scorecard), and more.
- **Say:** "Feature-for-feature parity with Fabric's item types, plus Azure-native items Fabric doesn't have."

### 3. The **CSA Loom Demo** workspace — walk the core items (5–6 min)
Open **Workspaces → CSA Loom Demo**. Open these in order:
- **Revenue Analysis Notebook** — full authoring surface; the **compute selector shows `loompool (Synapse Spark) · Available`** plus Databricks cluster tiers (`loom-cluster-s/m/l`). *"Real warm Spark — a cell runs against a live Livy session, no cold-start."*
- **Sales Lakehouse** — Delta tables over ADLS; Tables/Files explorer.
- **Executive Sales Report** — the **report designer**: pages, 25+ visuals, AI visuals, field wells. Click **Data source → Get data** and show **"Use a Loom item"** (bind a report straight to a Loom semantic model / lakehouse — Azure-native, no Power BI workspace needed).
- **Sales Semantic Model** — measures/DAX, relationships, storage modes incl. **Direct Lake** (Fabric-parity, reads Delta live). Note the honest "Power BI embed is opt-in" banner.
- **Bronze→Silver→Gold Pipeline** — the pipeline canvas (ADF-parity).

### 4. Real-Time Intelligence (2 min)
Left nav → **Real-Time Intelligence → Streams**.
- **Say:** "Banner says it explicitly — *no Microsoft Fabric capacity required*." Show the **27 Azure-native source connectors** (Event Hubs, IoT Hub, Service Bus, SQL/Cosmos/Postgres/Mongo/Oracle CDC, Kafka, Kinesis, Pub/Sub).
- Tabs: **Discover sources** (finds raw Azure event sources across every subscription), **Activator** (Azure Monitor-backed rules), **Business events**.

### 5. Governance (2 min)
Left nav → **Governance**.
- **Connected to Microsoft Purview — live.** Point out **605 governed items**, coverage-by-item-type, classification/sensitivity, lineage.
- **Say:** "Real Purview Data Map + Unity Catalog + OneLake catalog sync — governance is Azure-native and live from day one."

### 6. Use-case apps (2 min)
Open **Workspaces → CSA Loom Demo — Apps** (or **Marketplace / Apps**). Show the installed compound apps (Data Governance, Real-Time Dashboards, ML Pipeline, FinOps) — **one-click install that provisions + seeds a whole vertical**. There are ~29 use-case apps in the catalog.

### 7. Copilot (1 min)
Open **Copilot** (left nav). Ask it something about the workspace ("summarize the items in this workspace" / "how do I build a medallion lakehouse"). It grounds on the live Loom context.

### 8. Admin / platform health — the "it's real" close (2 min)
Top-right **⚙ Settings → Admin**:
- **Health & Self-audit** → **100**. **Runtime config → 73 / 73** configured.
- **Scaling** → per-SKU scaling of Synapse/Databricks/SQL.
- **Usage & Chargeback** → real Azure Cost Management spend, per-workspace attribution across every subscription.
- **MCP servers** → Microsoft + gov-safe MCP servers enabled by default.
- **Say:** "Everything is real, wired to real Azure backends, and default-on — nothing is a mock."

---

## Talking points / differentiators
- **No Fabric dependency:** every item works 100% Azure-native by default; Fabric/Power BI is strictly opt-in. This is the sovereignty story for Gov.
- **Both clouds, day-one:** the same product runs in Commercial and Azure Government (GCC-High).
- **Real compute, warm:** multi-size Synapse Spark pools + Databricks clusters, pre-warmed so notebooks are instant.
- **Weave:** turn any Loom item into a Power BI model / API / lineage graph with one click.
- **Fabric parity + more:** Direct Lake, mirroring, OneLake catalog, semantic models — plus Azure-native items and a Palantir-style ontology layer.

## If asked "what's not done yet"
- The **Gov data-plane** demo environment is being stood up in parallel (dlz-attach into the Gov landing zone) — the Gov *console* is already live.
- UX polish is an ongoing sweep to exceed the Fabric visual bar on every surface.
