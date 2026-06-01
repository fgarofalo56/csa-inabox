# power-platform — parity with the Power Platform admin center + Power Apps / Power Automate / Power Pages maker studios

**Source UI:**
- Power Platform admin center — https://admin.powerplatform.microsoft.com (Learn: https://learn.microsoft.com/power-platform/admin/admin-documentation)
- Power Apps maker — https://make.powerapps.com (Learn: https://learn.microsoft.com/power-apps/maker/canvas-apps/intro-maker-portal)
- Power Automate maker — https://make.powerautomate.com
- Power Pages design studio — https://make.powerpages.microsoft.com
- Dataverse Web API — https://learn.microsoft.com/power-apps/developer/data-platform/webapi/overview

**Loom surface:**
- Navigator: `apps/fiab-console/lib/components/powerplatform/powerplatform-tree.tsx`
- Editors: `apps/fiab-console/lib/editors/powerplatform-editors.tsx` (6 editors, registered in `lib/editors/registry.ts` lines 110-115)
- Control-plane BFF: `apps/fiab-console/app/api/powerplatform/{environments,apps,flows,connections,connectors,tables}/route.ts`
- Item-plane BFF: `apps/fiab-console/app/api/items/{dataverse-table,power-app,power-automate-flow,power-page,ai-builder-model}/**/route.ts`
- Client (all real REST, no mocks): `apps/fiab-console/lib/azure/powerplatform-client.ts`

**Scope note.** The real product is a *family* of portals, not one Azure blade. Loom collapses the admin-center left rail + the three maker studios into one navigator + six editors. Parity is graded against the union of those surfaces. Loom's design philosophy here is **read + inspect + run-lifecycle on real REST**; deep *authoring* (canvas designer, flow designer, Pages design studio, table column wizard) is honestly deep-linked to the proprietary Microsoft studios rather than faked. Per `ui-parity.md`, deep-linking authoring to the real studio is **not** an honest substitute for building the surface — so authoring rows below are graded MISSING/⚠️, not built.

Legend: built ✅ (full 1:1 + real backend) · partial ⚠️ (exists, incomplete/read-only/rough) · gated ⚠️ (honest infra-gate only) · MISSING ❌

---

## Azure/Power Platform feature inventory → Loom coverage

### A. Admin center — Manage › Environments (control plane)

| # | Capability (real UI) | Loom | Status | Backend |
|---|---|---|---|---|
| A1 | List environments (grid, sort, filter) | Env dropdown + tree root + filter box | ✅ built | `GET BAP …/scopes/admin/environments` |
| A2 | Environment details pane (URL, type/SKU, state, region, domain, instance URL, default flag) | Detail metaGrid in `PowerPlatformEnvironmentEditor` | ✅ built | `GET BAP …/environments/{name}?$expand=…` |
| A3 | **New** environment (create dialog: name/region/type/Dataverse/currency/language) | New dialog in `EnvironmentLifecycleBar` — display name, SKU, region, "create a Dataverse database" toggle (base language + currency when on); async provisioning poll | ✅ built | `POST BAP …/scopes/admin/environments?api-version=2021-04-01` (`{properties:{displayName,environmentSku,linkedEnvironmentMetadata}}`) + `GET …operation` poll |
| A4 | **Edit** environment (name, description, security group) | Edit dialog (rename + description) in `EnvironmentLifecycleBar` | ✅ built | `PATCH BAP …/environments/{id}?api-version=2021-04-01` |
| A5 | **Copy** environment (Everything / customizations-only, transactionless, target) | Command-bar button → honest MessageBar naming the Power Platform Admin op (`Copy-PowerAppEnvironment` / admin centre) | ⚠️ gated | none (no tenant-safe single BAP REST in the SP grant) |
| A6 | **Backup & Restore** (system + manual backups, retention, delete manual backup) | Command-bar button → honest MessageBar naming `Restore-PowerAppEnvironment` / admin centre | ⚠️ gated | none |
| A7 | **Reset** environment | Command-bar button → honest MessageBar naming `Reset-PowerAppEnvironment` / admin centre | ⚠️ gated | none |
| A8 | **Delete** / recover environment | Delete confirm dialog (async soft-delete + poll) in `EnvironmentLifecycleBar`; default-env button disabled | ✅ built | `DELETE BAP …/environments/{id}?api-version=2021-04-01` + `GET …operation` poll (404 = removed) |
| A9 | **Convert to production** | Command-bar button → honest MessageBar naming the admin op | ⚠️ gated | none |
| A10 | Environment **History** timeline (action/start/end/initiator/status) | Command-bar button → honest MessageBar (admin-centre operations feed, needs Admin role) | ⚠️ gated | none |
| A11 | Capacity / storage summary per env | Caption admits "—" when SP lacks scope; no grid | ⚠️ partial | partial (`$expand=…/billingPolicy` requested, not surfaced) |
| A12 | Enable / Edit **Managed Environments** (protection level, sharing limits, usage insights, solution checker, maker welcome) | none | ❌ MISSING | none |
| A13 | Environment **groups** | none | ❌ MISSING | none |

### B. Admin center — Manage › Tenant settings, Security, Copilot, Monitor, Deployment, Licensing, Support, Actions

| # | Capability | Loom | Status | Backend |
|---|---|---|---|---|
| B1 | **Tenant settings** (env-creation governance, sharing, etc.) | none | ❌ MISSING | none |
| B2 | **Security** page / **DLP data policies** (create/edit connector classification) | Honest ⚠️ "needs admin role" row → deep-links to admin center DLP | ⚠️ gated | none (correctly disclosed: needs Power Platform Admin role, not the API allow-group) |
| B3 | **Copilot** hub (usage, governance) | none | ❌ MISSING | none |
| B4 | **Monitor** (operational health metrics) | none | ❌ MISSING | none |
| B5 | **Deployment** / **Pipelines** (ALM deployment hub, approvals) | none | ❌ MISSING | none |
| B6 | **Licensing** consumption summary | none | ❌ MISSING | none |
| B7 | **Actions** / advisor recommendations | none | ❌ MISSING | none |
| B8 | **Support** ticket creation | none | ❌ MISSING | none |

### C. Power Apps (per environment)

| # | Capability | Loom | Status | Backend |
|---|---|---|---|---|
| C1 | List apps (canvas + model-driven) with type/owner/modified | App list in `PowerAppEditor` + tree "Apps" group with live count | ✅ built | `GET PowerApps …/scopes/admin/environments/{env}/apps` |
| C2 | App details (id, type, owner, version, created/modified, shared-with counts) | Detail metaGrid + connector/data-source table | ✅ built | `GET PowerApps …/apps/{name}` |
| C3 | **Publish** latest revision | "Publish" button + ribbon action | ✅ built | `POST …/apps/{name}/publishAppRevision` |
| C4 | **Play / embed** canvas app | Inline web-player iframe + new-tab fallback; model-driven → deep link | ✅ built | `apps.powerapps.com/play/{id}?source=iframe` |
| C5 | **Delete** app | Delete action in navigator | ✅ built | `DELETE …/apps/{name}` |
| C6 | **Share** app (add users/groups, co-owner, security roles) | none (admin Share is a documented core admin op) | ❌ MISSING | none |
| C7 | **Edit** canvas app (Studio designer) | Deep-link to make.powerapps studio only | ❌ MISSING (authoring) | none |
| C8 | **Export / Import** app package (.msapp / solution) | none | ❌ MISSING | none |
| C9 | Conditional-access / allowed-apps governance | none | ❌ MISSING | none |
| C10 | Bind a Loom item to a real (env, appId, appType) | Bind / re-bind flow persisted to item state | ✅ built (Loom-specific) | `POST /api/items/power-app/{id}/state` |

### D. Power Automate (cloud flows, per environment)

| # | Capability | Loom | Status | Backend |
|---|---|---|---|---|
| D1 | List flows with state/trigger/modified | Flow list + tree "Cloud flows" group | ✅ built | `GET Flow …/scopes/admin/environments/{env}/flows` |
| D2 | Flow details | Detail metaGrid in `PowerAutomateFlowEditor` | ✅ built | `GET Flow …/flows/{name}` |
| D3 | **Turn on / off** (start/stop) | Start/Stop inline actions in navigator | ✅ built | `POST …/flows/{name}/start|stop` |
| D4 | **Run** flow (manual trigger) | "Run flow" button | ✅ built | `POST …/flows/{name}/triggers/manual/run` |
| D5 | **Run history** (status, start/end, error) | Recent-runs grid | ✅ built | `GET …/flows/{name}/runs?$top` |
| D6 | **Delete** flow | Delete action in navigator | ✅ built | `DELETE …/flows/{name}` |
| D7 | **Edit** flow (designer canvas) | Deep-link to make.powerautomate only | ❌ MISSING (authoring) | none |
| D8 | Flow **owners / run-only users / connections** management | none | ❌ MISSING | none |
| D9 | Export / import flow (package/solution) | none | ❌ MISSING | none |
| D10 | Desktop flows / process mining | none | ❌ MISSING | none |
| D11 | Resubmit / cancel a specific run | none (runs are read-only) | ❌ MISSING | none |

### E. Dataverse tables (per environment)

| # | Capability | Loom | Status | Backend |
|---|---|---|---|---|
| E1 | List tables (custom + system) | Table list + tree "Dataverse tables" group | ✅ built | `GET {org}.crm.dynamics.com/api/data/v9.2/EntityDefinitions` |
| E2 | **Columns** tab (logical/display/type/required/custom, PK/Name badges) | Columns grid | ✅ built | `GET …/EntityDefinitions(…)/Attributes` |
| E3 | **Keys** (alternate keys + index status) | Keys grid | ✅ built | `GET …/Keys` |
| E4 | **Relationships** (1:N / N:1 / N:N) | Relationships grid | ✅ built | `GET …/{One,Many}ToMany…RelationshipMetadata` |
| E5 | **Views** (system / personal, default) | Views grid | ✅ built | `GET …/savedquery|userquery` |
| E6 | **Business rules** (state) | Business-rules grid | ✅ built | `GET …/workflow` |
| E7 | **Data** grid (rows, formatted values, top N) | Data tab (top 25, read-only) | ⚠️ partial | `GET …/{entitySet}` (read-only; no create/edit/delete row, no paging, no query editor) |
| E8 | **Create** custom table (publisher prefix, ownership, primary column wizard) | Honest MessageBar → maker portal | ❌ MISSING (authoring) | none |
| E9 | **Add / edit / delete column** (designer) | none (read-only inspector) | ❌ MISSING | none |
| E10 | **Edit / create / delete** relationship, key, view, business rule | none | ❌ MISSING | none |
| E11 | Forms / charts / dashboards / commands designers | none | ❌ MISSING | none |
| E12 | Edit row data inline / new row / delete row / bulk edit | none | ❌ MISSING | none |
| E13 | Import data (Excel / CSV / dataflow) | none | ❌ MISSING | none |

### F. Connections & connectors (per environment)

| # | Capability | Loom | Status | Backend |
|---|---|---|---|---|
| F1 | List connections (status badge) | Tree "Connections" group | ✅ built | `GET PowerApps …/connections` |
| F2 | **Delete** connection | Delete action | ✅ built | `DELETE …/connections/{connectorId}/{name}` |
| F3 | **Create** connection / fix-connection / consent | Deep-link to maker only | ❌ MISSING | none |
| F4 | List connectors (standard + custom flagged, tier) | Tree "Connectors" group | ✅ built | `GET PowerApps …/apis` |
| F5 | **Create / edit** custom connector (definition wizard, test) | Deep-link to maker only | ❌ MISSING (authoring) | none |

### G. Power Pages (per environment)

| # | Capability | Loom | Status | Backend |
|---|---|---|---|---|
| G1 | List sites (domain, status, type) | Sites grid in `PowerPageEditor` | ✅ built | `GET {org}.crm.dynamics.com …/mspp_websites` |
| G2 | Site details (id, domain, URL, status, created/modified) | Detail metaGrid | ✅ built | `GET …/mspp_websites({id})` |
| G3 | Open live site | Link out | ✅ built | derived `websiteurl` |
| G4 | Edit pages / templates / web roles / content snippets (design studio) | Honest MessageBar → make.powerpages | ❌ MISSING (authoring) | none |
| G5 | Provision / delete a Pages site, manage / restart | none | ❌ MISSING | none |

### H. AI Builder (per environment)

| # | Capability | Loom | Status | Backend |
|---|---|---|---|---|
| H1 | List models (template/type, state, status) | Models grid in `AiBuilderModelEditor` | ✅ built | `GET {org}.crm.dynamics.com …/msdyn_aimodels` |
| H2 | Model details | Detail metaGrid | ✅ built | `GET …/msdyn_aimodels({id})` |
| H3 | **Train** | Train button + ribbon | ✅ built | `POST` Dataverse train action |
| H4 | **Publish** | Publish button + ribbon | ✅ built | `POST` Dataverse publish action |
| H5 | **Predict** (real-time) | Predict JSON textarea + run | ✅ built | `POST` Dataverse Predict action |
| H6 | Build / configure model (choose type, training data, document type, fields) | Honest MessageBar → maker AI hub | ❌ MISSING (authoring) | none |

### I. Cross-cutting

| # | Capability | Loom | Status | Backend |
|---|---|---|---|---|
| I1 | Per-environment navigator with live counts + inline actions | Fluent v9 Tree, lazy-load per env | ✅ built | all routes above |
| I2 | Honest infra-gate when SP not configured | Whole-tree + per-editor MessageBar naming `LOOM_UAMI_CLIENT_ID` + allow-group | ✅ built (gate) | n/a |
| I3 | Dataverse sub-gate (UAMI ≠ Dataverse App User) without gating the tree | Tables-only sub-gate naming `LOOM_DATAVERSE_CLIENT_ID/_SECRET` | ✅ built (gate) | n/a |
| I4 | Real 401/403 remediation hints surfaced | `hint`/`endpoint` plumbed through every route | ✅ built | n/a |
| I5 | Solutions / ALM (managed/unmanaged, import/export) | Honest ⚠️ row → maker (client `listSolutions` exists, no navigator group) | ⚠️ partial | partial |

---

## Tally

- **built ✅:** 28
- **partial ⚠️ (incl. honest gates that still leave authoring missing):** 5 (A11 capacity, E7 data-read-only, I5 solutions, B2 DLP gate, I2/I3 gates count as built)
- **gated ⚠️ (honest infra-gate, no function by design):** 2 (B2 DLP, plus the global config gate I2 which is built)
- **MISSING ❌:** 38

> Counts used for the structured verdict consolidate I2/I3/I4 gate plumbing as built, and treat the honest config gate as a single gated row.

---

## Honest verdict

**Grade: C (functional but far from parity).**

What's genuinely strong (B/A-grade in isolation): every **read** path and the **per-object lifecycle run actions** are real, end-to-end, no mocks — list/inspect environments, apps, flows, connections, connectors, Dataverse tables (6 facets), Power Pages, AI Builder; plus publish-app, flow start/stop/run/run-history, app/flow/connection delete, AI train/publish/predict. The navigator is a faithful Fluent-v9 reimagining of the admin-center left rail with live counts and real inline actions. Gating is honest and precise. Vitest contract tests exist for all six editors.

Why it is **not** B/A overall: the real product is overwhelmingly an **authoring + environment-lifecycle** surface, and Loom builds almost none of that. The entire environment lifecycle command bar (New / Edit / Copy / Backup-Restore / Reset / Delete / Convert / History / Managed-Environments / Groups) is **absent** — replaced by a read-only registry and admin-center deep links. Every designer (canvas, flow, table column/forms/views, custom connector, Pages studio, AI Builder build) is deep-linked out, which `ui-parity.md` explicitly forbids as a parity substitute. Seven of the eight admin-center top-level feature areas (Tenant settings, Security, Copilot, Monitor, Deployment/Pipelines, Licensing, Support, Actions) have no surface at all. App **Share** — a documented core admin op — is missing.

So: a solid, real-backed *operations console* over Power Platform, but materially short of "whatever you can do in the portal you can do in Loom." Grade conservatively **C**.
