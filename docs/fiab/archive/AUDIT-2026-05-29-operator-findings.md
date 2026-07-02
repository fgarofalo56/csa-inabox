# CSA Loom — Operator hands-on audit (2026-05-29)

**Context:** Automated deep UAT reported A:90, but a live hands-on walk by the operator
found ~25 surfaces broken, error-throwing, or non-functional shells. This invalidates
the automated verdict. Every row below must be fixed AND verified live (authenticated
Playwright walk + real backend response receipt + screenshot) before it can be called
done. No "A" without a live receipt. See `.claude/rules/no-vaporware.md`,
`.claude/rules/ui-parity.md`, and the `no-scaffold-claims` standard.

## Verification standard (new — applies to every row)
A surface is DONE only when:
1. **Live audit** of the real Azure/Fabric/Power BI UI (Playwright against the operator's
   limitlessdata tenant) — inventory every capability.
2. **Build** the Loom surface one-for-one against the **real Azure REST/data-plane** (MS Learn-grounded).
3. **Live verify** — authenticated session walk, click every control, capture the real
   response (first 300 chars) + a screenshot. Errors mean NOT done.
4. **Receipt** attached (endpoint, real response, screenshot/trace).

## Findings (status: ❌ = broken/garbage per operator; ⏳ = fix in flight; ✅ = live-verified)

| # | Surface | Operator complaint | Real backend it MUST use | Status |
|---|---------|--------------------|--------------------------|--------|
| 1 | Real-time dashboard (KQL dashboard) | missing functionality, missed the mark | ADX/Kusto KQL dashboard model | ❌ |
| 2 | Semantic model UI/DAG | can't build a model, not functional at all | Power BI / XMLA / TMSL semantic model authoring | ❌ |
| 3 | Power BI report | DAG buttons dead; nothing like PBI web; maybe needs PBI Embedded + dev API | Power BI Embedded + REST | ❌ |
| 4 | AI Foundry **project** | throws error; should work like Azure AI Foundry projects (project scope) | AI Foundry project data-plane REST | ❌ |
| 5 | Event stream DAG builder | wonky, not functional | Fabric Eventstream REST / topology | ❌ |
| 6 | Databricks **job** UI | not functional, nothing like Databricks | Databricks Jobs REST 2.1 | ❌ |
| 7 | Synapse pipeline / integrate canvas | garbage; `getPipeline 404 PipelineNotFound` (syn-loom-default-eastus2) | Synapse Pipeline REST + visual activity model | ❌ |
| 8 | MLflow / ML model | errors, won't load; must be backed by AML | Azure ML (AML) REST / MLflow | ❌ |
| 9 | KPI tree / scorecard | garbage, errors out; Fabric Scorecard preview gate | Power BI Metrics/Goals REST | ❌ |
| 10 | PowerApps builder canvas | errors; `api.powerapps.com .../apps/{id} failed`; nothing like PowerApps | Power Apps + Power Platform REST / embed | ❌ |
| 11 | Prompt flow / LangChain graph | not usable; needs visual builder w/ JSON I/O | AI Foundry prompt flow REST | ❌ |
| 12 | AI Search index | fails "not found", editor useless, can't manage index | Azure AI Search data-plane REST | ❌ |
| 13 | ADF pipeline builder | garbage; `getPipeline 404 NotFound` (adf-loom-default-eastus2); must equal ADF | ADF REST + visual activity canvas | ❌ |
| 14 | SQL database | wrong concept (Fabric SQL "no workspace"); must be Azure SQL DB / MI / Postgres Flex; deploy + tenant query + OneLake integ | ARM (SQL/MI/PG Flex) + TDS query | ❌ |
| 15 | API marketplace (side nav) | can't do anything | (define) | ❌ |
| 16 | Unified catalog | Purview-not-provisioned errors though it IS provisioned; wiring broken | Purview Unified Catalog REST | ❌ |
| 17 | Governance tab | useless; should be Purview governance framework | Purview governance REST | ❌ |
| 18 | Monitor tab | useless; should be Azure-Monitor-for-everything-in-Loom (full observability stack) | Azure Monitor / Log Analytics / App Insights | ❌ |
| 19 | Real-time hub | doesn't work; should be Fabric Real-Time hub | Fabric RTI / Eventstream sources | ❌ |
| 20 | Data agents | can't scroll to Send; send errors; UI "looks like shit"; redo; back by Azure | AI Foundry Agent Service + grounded data-plane | ❌ |
| 21 | Copilot agent tab | constant screen flicker, unusable (likely render loop) | (live chat backend) | ❌ |
| 22 | Workflow hub | rudimentary; needs modern design like homepage (spacing, no text butting boxes) | (UI redesign) | ❌ |
| 23 | Deployment tab | not usable; "no ADF linked service found"; rebuild to operator vision | ARM deployment inventory | ❌ |
| 24 | Admin portal (all tabs) | each tab needs eval; "domains" meaning unclear | (per-tab) | ❌ |
| 25 | Setup wizard | doesn't work; can't select subscription; errors before sub/monthly deploy | ARM subscriptions list + deploy | ❌ |

## In-flight (built by agents 2026-05-29, NOT yet live-verified — do NOT claim done)
- PR #460 data-product Purview register (body-shape fix)
- PR #461 lakehouse query + right-click menu + shortcuts
- PR #462 databricks notebook (cell-based)
- PR #463 foundry hub account picker + data-agent sources coercion

These are built + unit-tested but await the live-receipt step above. They map to rows 16/20 partially and the lakehouse/databricks/foundry-hub surfaces.

## Live audit results — receipts (2026-05-29, authenticated session, real item IDs)

Authenticated Playwright walk against the live deployment using the operator's session
and REAL Cosmos item IDs. Receipts (HTTP status + response body) captured to
`temp/audit-2026-05-29/audit.json`, screenshots in `temp/audit-2026-05-29/shots/`.

### SYSTEMIC ROOT CAUSE #1 — item-id ≠ Azure-resource-id
Several editors pass the Loom Cosmos item GUID directly to the Azure backend as the
native resource identifier, so Azure 404s. The correct model (per operator): a Loom item
must **bind to / select / deploy** a real Azure resource (and be able to query the tenant
for existing ones), storing the real Azure id in item `state`.

| Surface | Receipt | Grade |
|---------|---------|-------|
| synapse-pipeline | `502` ← `getPipeline(bb3da001-…) failed 404 PipelineNotFound` (syn-loom-default-eastus2) | **F** |
| adf-pipeline | `502` ← `getPipeline(d22e087b-…) failed 404 NotFound`; `/runs` → `404` **HTML** (content-type bug) | **F** |
| ml-model | `404 {"ok":false,"error":"not found"}` on `/api/items/ml-model/<guid>` | **F** |
| ai-search-index | `404 {"ok":false,"error":"not found"}` | **F** |
| scorecard | `404 {"ok":false,"error":"The requested resource could not be found"}` (ws-scoped list) | **F** |
| power-app | `404` ← `GET api.powerapps.com/.../apps/<loom-guid> failed` (loom id used as app id) | **F** |
| data-agent | **F crash** — `CSA Loom hit an unexpected error` (the `eo.map`; fix unmerged in #463) | **F** |
| catalog (unified) | banner `Microsoft Purview is not provisioned` though it IS — wiring bug | **D** |

### Loaded clean but ZERO backend calls — operator-reported non-functional (interactive grade pending during rebuild)
eventstream, semantic-model, report, databricks-job, prompt-flow, kql-dashboard, copilot,
api-marketplace, governance, governance-purview, monitor, realtime-hub, workload-hub,
deployment-pipelines, admin, admin-domains, setup, databricks-notebook.
These render without a load-time API failure but fired no real backend call — consistent
with "renders but does nothing." Each gets a click-through verification as it's rebuilt;
no grade above C until a live receipt proves the primary action works.

## Method the operator authorized
- Playwright to navigate the operator's **live Azure portal / Fabric / Power BI** (limitlessdata tenant) to audit real UX.
- **Microsoft Learn MCP** for every service's REST API surface.
- Wire real REST/JSON/YAML config backends; honest MessageBar gate only when infra genuinely absent (and document the post-deploy step + add it to the setup wizard).
