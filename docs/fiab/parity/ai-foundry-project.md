# ai-foundry-project — parity with the Azure AI Foundry **project**

> **Standalone editor, but a child object of the hub.** `slug: ai-foundry-project`,
> `restType: AiFoundryProject`, category **Azure AI Foundry**. Editor:
> `ProjectEditor` in `apps/fiab-console/lib/editors/foundry-sub-editors.tsx`.
> A Foundry **project** is a child workspace under the
> [`ai-foundry-hub`](./ai-foundry-hub.md); it inherits the hub's connections /
> models / datastores and scopes prompt flows, evaluations, and data assets. The
> project-scoped authoring surfaces (prompt-flow, evaluation, dataset, tracing,
> content-safety, AI-search-index) are *sibling* catalog items with their own
> editors in the same file — this doc covers the project object itself (create /
> list / details); those siblings get their own parity docs.

**Catalog description:** "Child workspace under the Foundry hub. Inherits
connections/models/datastores; scopes prompt flows, evaluations, and data assets."

**No-Fabric note:** a project is `Microsoft.MachineLearningServices/workspaces`
(kind=Project) bound to the hub via `hubResourceId`. 100% Azure-native; no
Fabric/Power BI. Unwired → `NotDeployedError` → 503 honest gate.

Source UI: **Azure AI Foundry portal — project** (`https://ai.azure.com/projects/{name}`)
- Create a project: <https://learn.microsoft.com/azure/ai-foundry/how-to/create-projects>
- Hub vs project: <https://learn.microsoft.com/azure/ai-foundry/concepts/ai-resources>
- Management center (projects list): <https://learn.microsoft.com/azure/ai-foundry/concepts/management-center>
- Project REST (`Workspaces - Create Or Update`, kind=Project): <https://learn.microsoft.com/rest/api/azureml/workspaces/create-or-update>

## Azure AI Foundry project — feature inventory

| # | Capability in Foundry | Notes |
|---|-----------------------|-------|
| 1 | **Create project** under a hub — name, display name, description; region/hub inherited | `hubResourceId` |
| 2 | **List projects** under the hub (management center) | filter by hub |
| 3 | **Project overview** — name, display name, description, provisioning state, location, parent hub, endpoints | details blade |
| 4 | **Project settings** — connections (inherited + project-scoped), members/RBAC, cost, delete | manage |
| 5 | **Scoped authoring** — prompt flows, evaluations, data assets, indexes run *within* the project | sibling surfaces |
| 6 | Deep-link into the live portal project | portal hop |

## Loom coverage

Backend via `foundry-client.ts` → ARM
`Microsoft.MachineLearningServices/workspaces` in the hub's RG, filtered to
kind=project with matching `hubResourceId`. BFF: `/api/items/ai-foundry-project`
(GET list / POST create), `/api/items/ai-foundry-project/[id]` (GET detail).

| # | Capability | Status | Detail |
|---|-----------|--------|--------|
| 1 | Create project | built ✅ | "New project" card — name / display name / description → `POST /api/items/ai-foundry-project` → `createProject()` (binds `hubResourceId` from `LOOM_FOUNDRY_HUB_NAME`/`LOOM_FOUNDRY_NAME`) |
| 2 | List projects | built ✅ | table of name / display / state / location; `EmptyState` when none; `ErrorBar` with honest `notDeployed` hint |
| 3 | Project overview / details | built ✅ | detail view: name, display, description, provisioning state, location, parent hub (from `hubResourceId`), Reload |
| 4 | Project settings (RBAC / connections / cost / delete) | honest-gate ⚠️ / partial | connections + RBAC are surfaced at the **hub** editor (inherited by projects); dedicated project-scoped settings/members/delete panels ❌ not in this editor |
| 5 | Scoped authoring | built ✅ (elsewhere) | prompt-flow / evaluation / dataset / tracing / content-safety / ai-search-index are sibling editors (`foundry-sub-editors.tsx`) that take a **project** via `ProjectPicker` |
| 6 | Portal deep-link | built ✅ | ribbon deep-links to `https://ai.azure.com/projects/{name}` |

## Backend per control

| Loom control | Route | Azure backend |
|--------------|-------|---------------|
| List projects | `GET /api/items/ai-foundry-project` → `listProjects()` | ARM `GET …/workspaces` (filter kind=project + hubResourceId) |
| Create project | `POST /api/items/ai-foundry-project` → `createProject()` | ARM `PUT …/workspaces/{name}` (kind=Project, hubResourceId set) |
| Project detail | `GET /api/items/ai-foundry-project/{id}` → `getProject()` | ARM `GET …/workspaces/{name}` |
| Scoped surfaces | `/api/items/prompt-flow`, `/api/items/evaluation`, `/api/items/dataset`, … | project-scoped ML/AOAI data-plane |

**Grade: B.** The project *object* lifecycle (create → list → view details, with
a real hub binding) is fully functional on ARM ML-workspace REST, and every
project-scoped authoring surface is built as a sibling editor that consumes the
project. The honest gap is a consolidated **project settings** blade
(project-scoped members/RBAC/connections/cost/delete) in this editor — those
controls presently live at the hub level or are not yet surfaced.
