# CSA Loom — Wave 11 (operator deep feedback: admin portal, governance, lineage, RTI, marketplace, wizard, MDM/DQ, dbt, Rayfin)

From direct operator walkthrough (2026-06-10). Built via the normal Unleash loop
(research → code → review → frontend Polish → PR → integrate → release), with
ABUNDANT research (microsoft_docs_search + real Azure/Databricks/Purview REST) and
A-grade UIs. Honor no-vaporware (real backend or honest Fluent gate — but the goal
is to WIRE these up so they're not gated), no-fabric-dependency (Azure-native
default), loom-no-freeform-config, ui-parity, loom-design-standards, bicep+bootstrap
sync (many of these are "not wired in this deployment" = MUST add the env/role/
resource to bicep + post-deploy bootstrap so they're configured BY DEFAULT).
New Azure/OSS services may be added where needed.

Launch: `loom-unleash-fast {files:[AUDIT-2026-06-10.md, AUDIT-2026-06-10-deep.md, audit-wave11-admin-gov-lineage.md], auditWave:11, fanout:5}`.

## ADMIN PORTAL — BUGS (high priority; fix + wire-by-default)

### audit-T124 — Admin > API Management: "unexpected token" error (BUG) | Wave 11
- ask: "On the admin portal, API Management, I get an unexpected token error, nothing works."
- goal: Diagnose (almost certainly a BFF route returning HTML/empty instead of JSON, or a JSON.parse on a non-JSON body / missing APIM env). Fix the route + client so the admin APIM surface loads real data or shows an honest Fluent gate naming the env var/role. Wire the APIM service env + RBAC into bicep + bootstrap so it's configured by default.
- files: admin APIM pane + `app/api/**apim**`, `lib/azure/apim*`, bicep apim module.

### audit-T125 — Admin > Security & Governance > Purview: 403 Not authorized (BUG) | Wave 11
- ask: "the purview options doesn't load, says 403 not authorized."
- goal: Grant the Console UAMI the required Purview data-plane roles (Data Map: Data Curator/Reader on the Purview/Unified-Catalog account) in bicep + bootstrap so it's authorized by default; fix the client to use the right scope/endpoint. Real data or honest gate.

### audit-T126 — Admin > Information Protection: not editable / no management (ENHANCE) | Wave 11
- ask: "information protection just shows stuff. Add configuration + ability to manage/administer sensitivity labels, label policies, apply label. Label policy gives 400. Apply label is confusing/not fully integrated."
- goal: Full MIP management: create/edit/delete **sensitivity labels**, **label policies** (fix the 400 — likely a malformed Graph/Security & Compliance payload), and a clear **apply-label** workflow (label an item/scope). Wire to the real Microsoft Purview Information Protection / Graph API with the UAMI granted the needed roles (bicep + bootstrap). Guided wizards, not raw JSON.

### audit-T127 — Admin > DLP: error, "not wired in this deployment" (BUG/wire) | Wave 11
- ask: "DLP throws an error, not wired in this deployment, fix that, should be automatically configured."
- goal: Wire DLP (Purview DLP for Fabric/OneLake-equivalent → ADLS/Synapse scopes per audit-T99) to a real backend + auto-configure via bicep/bootstrap (env + role). Real policy CRUD or honest gate.

### audit-T128 — Admin > Embed codes: "not wired in this deployment" (wire) | Wave 11
- ask: "embed codes says not wired in this deployment. Make sure it's configured and wired up." (F23 embed-codes shipped UI — wire its backend + env by default.)
- goal: Wire the embed-codes backend + env/bicep so it works by default (generate/manage embed tokens for reports/dashboards).

### audit-T129 — Admin > Organizational visuals: "not wired up" (wire) | Wave 11
- ask: "organizational visuals says not wired up."
- goal: Wire the org-visuals backend (custom visuals registry → ADLS/Cosmos store) + bicep env so it's configured by default.

### audit-T130 — Admin > Copilot usage: "could not load" (BUG) | Wave 11
- ask: "Copilot usage says could not load Copilot usage. Fix and integrate so it works."
- goal: Fix the copilot-usage route/source (usage emit shipped earlier; ensure the store + query + env are wired + deployed by default) so the admin panel loads real usage.

### audit-T131 — Admin > Network & DNS: CSA Loom network topology shows no values → visual topology (ENHANCE) | Wave 11
- ask: "the CSA Loom network topology doesn't show any values. It should visually show VNet, subnets, private endpoints, Azure services, etc."
- goal: Build a **visual network topology** (React Flow / canvas) rendered from the REAL deployed network (ARM: VNet/subnets/NSGs/private endpoints/private DNS zones + the Loom services bound to them). Nodes per resource, edges for connectivity. Read-only first; clickable detail.

## ADMIN — DEPLOYMENT PLANNER (flagship WYSIWYG)

### audit-T132 — Admin > Deployment planner: full WYSIWYG architecture builder + configure each resource + save plan + export Bicep (ENHANCE, flagship) | Wave 11
- ask: "you can drag and drop items but can't configure the resources. This should be a full WYSIWYG architecture builder, save the plan, export to Bicep, click each item to configure its settings. Best possible ultimate visual deployment planner."
- goal: Extend the existing deploy-planner (React Flow canvas, audit-T119 adds all Azure service-type nodes + Atlas Diag icons) into a true architecture builder: **click any node → a real config panel** for that resource type (SKU/tier, region, names, networking, dependencies); connect nodes; **save the plan** (Cosmos); **export to Bicep** (generate a real .bicep/.bicepparam from the planned graph — reuse the deploy-planner bicep emitter); validate the graph.

### audit-T133 — Deployment planner: "Estimate cost" (ENHANCE) | Wave 11
- ask: "an estimate cost option — plan it out, click estimate cost, either auto-load into the Azure calculator or auto-add a cost breakdown summary report."
- goal: Add **Estimate cost**: compute a per-resource + total monthly estimate from the planned graph using the **Azure Retail Prices API** (public, no auth: prices.azure.com/api/retail/prices) keyed by service/SKU/region, render an in-app **cost breakdown report** (table + total, by resource), AND offer an **"Open in Azure Pricing Calculator"** deep-link/export. Honest about estimate caveats.

## RTI

### audit-T134 — Real-Time Hub: empty dropdowns + create-if-missing + make it work (ENHANCE/BUG) | Wave 11
- ask: "real-time hub: if I click anything after selecting an object (event hub type / event hub name) the dropdown is empty. If one needs to be created it should tell you and auto-create. Enhance, make sure all features work."
- goal: Populate every dropdown from REAL subscription queries (Event Hubs namespaces/hubs, IoT, Kafka, etc.); when none exist, show an inline "Create new…" that really provisions (via the eventstream/EH provisioner) and selects it. End-to-end working source binding.

### audit-T135 — RTI catalog vs Real-Time Hub: clarify + make streams usable/testable (ENHANCE) | Wave 11
- ask: "what's the difference between RTI catalog and real-time hub? On RTI catalog the deployed data streams — you can't really do anything with them, can subscribe/create activator but can't use/test them."
- goal: Clarify the two surfaces (hub = browse/connect sources; catalog = deployed streams/eventhouses). For catalog items add real actions: **preview/test the stream** (peek EH/ADX events), query, open in eventstream/eventhouse editor, manage. Make subscribe + create-activator fully wired. Add explanatory copy.

## API MARKETPLACE

### audit-T136 — API marketplace: 401 missing subscription key + no key entry + try-in-browser + working curl (BUG/ENHANCE) | Wave 11
- ask: "API marketplace — is it like the data marketplace? Confusing. One API, clicking try → 401 missing subscription key, no way to enter a subscription key, should be integrated. My subscriptions — would be nice to have real-time try-in-browser. The curl examples don't work (subscription key invalid even though provided)."
- goal: (a) Add explanatory copy (what the API marketplace is vs data marketplace). (b) Fix subscription-key flow: a real APIM subscription is auto-provisioned for the user / selectable, the key is injected into the Try console + curl samples (Ocp-Apim-Subscription-Key) so they actually work; allow entering/selecting a key. (c) **Try-in-browser console**: invoke the API live from the UI and render the real response (status/headers/body). (d) Validate the published sample API end-to-end so a Try call returns 200.

## LINEAGE (unify Weave + Purview + Unity)

### audit-T137 — Lineage: stale entries after delete + clickable visual graph (BUG/ENHANCE) | Wave 11
- ask: "lineage tab (Weave) — if anything is deleted/removed the lineage still shows even though objects don't exist. Should auto-update. Would be nice to click lineage and see a visual graph (Purview-style) of object types and how they connect."
- goal: (a) Auto-reconcile lineage on item delete (remove/tombstone edges when a lakehouse/notebook/etc. is deleted). (b) **Visual lineage graph** (React Flow/canvas) — nodes typed by object, directional edges, click-to-expand, Purview-style.

### audit-T138 — Unified lineage: integrate Purview + Unity Catalog + Weave into one true end-to-end lineage (ENHANCE, big) | Wave 11
- ask: "integrate purview lineage, Unity catalog lineage, and weave lineage. Trace a report all the way back to datasets, ETLs, notebooks. Maximize lineage; unify all types for the underlying Azure services and Weave."
- goal: A unified lineage service that merges edges from **Purview Data Map lineage**, **Databricks Unity Catalog lineage (system.access.table_lineage / column_lineage)**, and **Weave (thread-edges)** into one graph keyed by a common asset identity; the catalog "Lineage" tab + the item lineage view render the full upstream/downstream (report → semantic model → warehouse/lakehouse → pipeline/notebook → source). Research the 3 lineage APIs deeply.

## UNIFIED CATALOG (Unity + Purview cohesion)

### audit-T139 — Unity Catalog configured by default (wire) | Wave 11
- ask: "under browse it says Unity Catalog — shouldn't it already have a configured Unity Catalog by default with the deployment? The whole integrated Unity Catalog as part of automatic deployment."
- goal: Ensure the Databricks **Unity Catalog metastore is provisioned + bound by default** in the deploy (bicep/bootstrap: metastore, default catalog, UAMI/SP grants) so Browse shows a real configured UC.

### audit-T140 — Catalog domains/collections: editable + sub-collections + move + domain mapping (ENHANCE) | Wave 11
- ask: "Purview domains show nothing/empty. Domain section shows collections but no way to edit/add collections or subcollections or move things. Collections + domain mapping/management through both Unity and Purview, tied together — anything domain-mapped in Loom maps to domains in Unity and Purview. Cohesive."
- goal: Full CRUD + reparent for **Purview collections/domains** AND **Unity Catalog catalogs/schemas as domains**; a unified Loom "domain" concept that writes through to BOTH Purview collections and UC; fix the empty domains (real query/create).

### audit-T141 — Catalog Metastores: Databricks workspace registration not persistent + Purview upgrade/scan (BUG/ENHANCE) | Wave 11
- ask: "I register a Databricks workspace, it adds it but it's not persistent. Should persist and be upgraded/added to Purview to be scanned. Metadata registration is missing functionality. Research deeply."
- goal: Persist metastore/workspace registrations (Cosmos), and on register: attach to the UC metastore + **register the workspace as a Purview source + trigger a scan** so its metadata is cataloged. Research the UC metastore-assignment + Purview registration/scan APIs.

## SETUP WIZARD

### audit-T142 — Setup wizard: subscription defaulting + full region lists + visual review + deploy-by-default orchestrator (BUG/ENHANCE) | Wave 11
- ask: "single subscription shouldn't need the dropdown — default to the admin-plane's subscription. Multi-select is where you pick subscriptions. Region option: include ALL supported regions per cloud (commercial → all commercial; gov → gov). Review&deploy: add a visual representation of what's deployed + connections. Deploy doesn't work — 'browser-driven setup orchestrator is not deployed here yet' — it should be deployed by default and auto-deploy if the logged-in user has permissions across the subs."
- goal: (a) Single-sub path auto-uses the admin-plane subscription (no dropdown); multi-select path for choosing subs. (b) Region dropdown sourced from the full supported-region list for the active cloud (Commercial/GCC/GCC-H/IL5). (c) Review step renders a **visual architecture diagram** of the planned deployment (reuse T132 canvas) alongside the generated Bicep. (d) **Deploy the browser-driven setup orchestrator by default** (bicep: the orchestrator Container App/Function + its RBAC) and wire the wizard's Deploy to actually run the multi-sub deployment when the signed-in user has rights. Research the orchestrator deployment + multi-sub deploy auth.

## NEW CAPABILITY AREAS

### audit-T143 — Master Data Management + Data Quality (governance) (NEW) | Wave 11
- ask: "nothing for master data management and data quality assurance. Should be under governance. Users should use MDM + DQ toolsets within their workspaces."
- goal: Add an MDM + DQ governance surface. DQ: rules/expectations + run + results (OSS **Great Expectations** or **Soda** executed on Synapse/Databricks; or Databricks Lakehouse Monitoring / Delta constraints) with a Loom UI. MDM: golden-record/match-merge + reference-data management (research an Azure/OSS approach). Real backend, guided UI.

### audit-T144 — dbt visual builder / WYSIWYG (ENHANCE) | Wave 11
- ask: "dbt stuff needs enhancing, maybe visual WYSIWYGs to help users build dbt for their lakes/Delta warehouses correctly."
- goal: A visual dbt model/project builder (model graph, sources, tests, materializations) that generates real dbt project files and runs them against Synapse/Databricks; help set up medallion/Delta correctly.

### audit-T145 — Rayfin / Fabric Apps: visual builder + wizards (ENHANCE, possibly under Weave) | Wave 11
- ask: "the fabric apps (Rayfin app) needs a ton of work — more visual builders and wizards, fully support how to build a Rayfin app. Maybe part of Weave. You figure out how to enhance Rayfin."
- goal: Make the Fabric-App (Rayfin) builder a real low-code visual app builder (pages, components, data bindings to semantic models / Loom items, actions), with wizards; decide + document whether it lives under Weave/Atelier (audit-T51) or standalone and align them. Real backend (app definition store + runtime).

### audit-T146 — Ensure all Fabric Build 2026 features integrated + UIs built (cross-check) | Wave 11
- ask: "any of the new fabric features we grabbed from Build, make sure those are all integrated and working and the UIs are built out with the ultimate configurations."
- goal: Cross-check Wave 8 (audit-T64..T87) delivered each Build-2026 feature with a real working UI; close any that shipped thin. (Mostly covered by Wave 8 — this is the verification/finish pass.)
