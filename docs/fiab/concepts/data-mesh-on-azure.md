# Data Mesh on Azure with CSA Loom

Data mesh is an organizational and architectural pattern for analytical
data at scale. Rather than centralizing all data in a single monolithic
data warehouse or lake, data mesh distributes ownership: each business
domain owns its own data as a **data product**, and a central governance
layer federates discovery, quality, and access across all domains.

The four principles (Zhamak Dehghani):

1. **Domain-oriented ownership** — teams own their data end to end.
2. **Data as a product** — each domain publishes data that meets
   discoverability, quality, and access standards.
3. **Self-serve data platform** — the platform makes it easy for any
   domain to produce and consume data products without central team
   bottlenecks.
4. **Federated computational governance** — policies are set centrally
   and enforced locally, not by a central gatekeeper.

## How CSA Loom implements data mesh on Azure

Loom maps all four principles to concrete Azure-native capabilities:

### 1. Domain ownership → Data Landing Zones

Each domain (agency, department, business unit) gets its own **Data
Landing Zone (DLZ)** — a dedicated Azure subscription with its own
storage, compute, RBAC, and cost reporting. A Domain Steward (an Entra
group) owns the DLZ and all workspaces inside it.

The Console → Setup Wizard "Add Data Landing Zone" action provisions a
new DLZ in ~30 minutes: the wizard interviews the domain name, region,
capacity SKU, and Domain Steward group, renders the `.bicepparam` live,
and deploys via the self-hosted Azure MCP server.

### 2. Data as a product → the data-product item type and Marketplace

Loom's **data-product** item type (`/items/data-product/<id>`) lets
a Domain Steward formally publish a dataset to the **cross-domain
Marketplace**. A data product has:

- A name, description, and owner domain.
- A MIP sensitivity label (Restricted-PII, Restricted-PHI, CUI,
  CUI-NSS) propagated from Microsoft Purview.
- An endorsement state (promoted / certified) set by the Department CDO.
- A Delta Sharing share that enables query-in-place access for approved
  consumers (no copy of the underlying data).
- A glossary (terms authored in Purview) and catalog tags.

Other domains discover published products via the Marketplace search
surface (backed by Azure AI Search) and submit access requests.

### 3. Self-serve platform → Loom Console + Setup Wizard

The Loom Console's workspace model (lakehouses, warehouses, notebooks,
pipelines, semantic models, reports, KQL databases, dashboards) gives
every domain team a self-serve data engineering environment without
waiting for a central platform team. The Setup Wizard and Copilot
agent guide new domains through provisioning.

For cross-domain access, the access-request → approve → grant flow is
automated: a Domain Steward approves a request with an optional
time-boxed window (e.g. 90 days); a Delta Sharing grant is created
automatically; the consuming domain's catalog adapter picks up the
shared tables within 5 minutes; no copy is made.

### 4. Federated governance → Purview + Sentinel + the Admin Plane

The Admin Plane (Department CIO / CDO governance) sets tenant-level
policies: sensitivity-label taxonomy, mandatory catalog tags, and
classification schemes. Domain Stewards override per-agency where the
policy permits. Cross-domain access events and cost facts flow to a
central **FederationAudit ADX database** and a Sentinel workspace,
giving the Department CIO:

- A cross-DLZ cost rollup (per-domain Azure consumption, MACC burn-down).
- An active-grants register (who has access to what, with days remaining
  in each time-boxed window).
- Label-violation detection (large Restricted-PII/PHI reads across
  domain boundaries trigger Sentinel alerts via the Activator engine).

## Setting up a federal data mesh in Loom: step by step

**Prerequisites:** a deployed Loom Admin Plane; at least two DLZ
subscriptions under the same Entra tenant; Purview configured
(`LOOM_PURVIEW_ACCOUNT` set).

### Step 1 — Onboard each agency as a DLZ

In the Loom Console:

1. Open **Setup Wizard** → **Add Data Landing Zone**.
2. Supply the agency's subscription ID, domain name, Azure region,
   capacity SKU, and Domain Steward Entra group.
3. The wizard deploys the DLZ (~30 min) and the domain appears in the
   Console domain tree.

Repeat for each agency or department you are onboarding.

### Step 2 — Install the Federal Data Mesh app

In any workspace within the Admin Plane, open the **App Library** and
install the **Federal Data Mesh** app
(`apps/fiab-console/lib/apps/content-bundles/app-federal-data-mesh.ts`).
This seeds:

- A **Cross-Domain Marketplace** data-product item with four sample
  agency products (Agency Performance Metrics, Grant Disbursement Facts,
  Beneficiary Outcomes, Mission Readiness Indicators) and a glossary.
- A **Federated Access Register** warehouse (T-SQL / Synapse Dedicated)
  tracking domain registry, published products, and the
  request → approve → grant lifecycle.
- A **Delta Sharing** notebook automating the cross-domain grant and
  catalog-adapter sync.
- A **FederationAudit KQL database** (ADX) for cross-DLZ access events,
  per-domain cost facts, and Sentinel label-violation detection.
- A **Department CIO Federation & Cost KQL dashboard**.
- An **Activator alert** that fires to Sentinel when large
  Restricted-PII/PHI reads are detected.
- An **AI Search index** powering Marketplace discovery.

### Step 3 — Publish a data product

1. In the producing domain's workspace, create a **data-product** item.
2. Set the name, classification (MIP label), and endorsement.
3. Link the Delta Sharing share that exposes the Gold-layer Delta tables.
4. The product appears in the Marketplace for other domains to discover.

### Step 4 — Request and approve cross-domain access

1. In the consuming domain's workspace, open the **Marketplace** and
   find the product.
2. Submit an access request with a stated use case.
3. The producing domain's Domain Steward approves in the Loom Console,
   optionally with a time-boxed window (e.g. 90 days).
4. The cross-domain Delta Sharing grant is created; the consuming
   domain's catalog adapter registers the shared tables within ~5 min.
5. Power BI reports in the consuming domain bind to the shared views.

### Step 5 — Monitor from the Admin Plane

Open the **FederationAudit** KQL database and the **Department CIO
Federation & Cost** dashboard to see:

- Active cross-domain grants and days remaining.
- Per-domain Azure cost rollup and trend.
- Cross-DLZ read events by classification.
- Open label-violation detections.

## Related pages

- [Federal Data Mesh use case](../use-cases/federal-data-mesh.md) —
  detailed pattern doc including the cross-domain example end to end.
- [Multi-Agency Onboarding use case](../use-cases/multi-agency-onboarding.md) —
  DLZ onboarding runbook and the Multi-Agency Onboarding Cockpit app.
- [Catalog — Domains](../catalog/domains.md) — Purview business-domain
  CRUD via the Loom Console.
- [Governance — Catalog](../governance/catalog.md) — catalog two-track
  architecture (Commercial vs Gov).
- [Reference architecture](../architecture.md) — tenancy model and
  per-boundary dispatch.
