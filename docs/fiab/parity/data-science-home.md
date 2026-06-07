# data-science-home — parity with the Fabric Data Science experience landing

Source UI: Microsoft Fabric **Data Science** experience home (workload landing
page reached from the Fabric experience switcher) and the Azure Machine Learning
studio home (https://ml.azure.com). Grounded in Microsoft Learn:
- https://learn.microsoft.com/fabric/data-science/data-science-overview
- https://learn.microsoft.com/azure/machine-learning/overview-what-is-azure-machine-learning

Loom route: `/experience/data-science/home`
Editor slug: `data-science-home` (registered in `lib/editors/registry.ts`)
BFF: `GET /api/items/data-science/home`

## Azure/Fabric feature inventory

| # | Capability in Fabric / AML home | Notes |
|---|---|---|
| 1 | Experience header / hero with the workload identity | Title + subtitle + at-a-glance counts |
| 2 | Recent **notebooks** list | Most-recently-modified notebooks, click to open |
| 3 | Recent **experiments** (runs) list | Recent ML experiment runs with status + time |
| 4 | Recent **models** (registrations) list | Recently registered models with version + time |
| 5 | Quick-create entry points (New notebook / experiment / model) | Buttons that launch the create wizards |
| 6 | "View all" / navigate-to-collection affordances | Jump from a recent strip to the full list |
| 7 | Curated learning / sample resources strip | Links to docs / tutorials / sample galleries |
| 8 | Reachable from the experience switcher | The workload tile/entry navigates here |

## Loom coverage

| # | Status | Implementation |
|---|---|---|
| 1 | built ✅ | `home-content.tsx` hero band + `counts` from the BFF |
| 2 | built ✅ | `recentNotebooks()` — Cosmos `items` cross-partition over the user's own workspaces, `itemType ∈ {notebook, synapse-notebook, databricks-notebook}`, TOP 5 by `updatedAt`. Tiles open `/items/<type>/<id>`. |
| 3 | built ✅ / honest-gate ⚠️ | `recentExperiments()` — real AML ARM `listJobs()` sorted by `startTimeUtc`, TOP 5. When AML env is unset/denied, an honest `intent="warning"` MessageBar names the exact env vars + role; the strip still renders. |
| 4 | built ✅ / honest-gate ⚠️ | `recentModels()` — real AML ARM `listModels()` sorted by `systemData.createdAt`, TOP 5. Same honest gate. |
| 5 | built ✅ | Three real `<a>` quick-create buttons → `/items/notebook/new`, `/items/ml-experiment/new`, `/items/ml-model/new`. Mirrored as a ribbon "Create" group in the editor. |
| 6 | built ✅ | Per-section "View all" / "New …" actions navigate to the browse list / create wizards. |
| 7 | built ✅ | "Learning resources" strip — 5 curated, stable Microsoft Learn links (explicitly labelled reference content, not live data). |
| 8 | built ✅ | `wl-data-science` GLOBAL workload seed gains `homeHref:'/experience/data-science/home'`; `workload-hub` `openWorkload()` routes there. Also a left-nav "Data Science" entry. |

Zero ❌, zero stub banners. The only non-functional state is the honest AML
infra-gate (items 3-4), permitted by `no-vaporware.md`.

## Backend per control

| Control | Backend |
|---|---|
| Recent notebooks tiles | Cosmos `items` + `workspaces` containers (`cosmos-client.ts`) — Azure-native, no Fabric dependency |
| Recent experiments tiles | Azure Machine Learning ARM `…/workspaces/{ws}/jobs?api-version=2024-10-01` via `foundry-client.listJobs()` (UAMI `ChainedTokenCredential`) |
| Recent models tiles | Azure Machine Learning ARM `…/workspaces/{ws}/models?api-version=2024-10-01` via `foundry-client.listModels()` |
| Quick-create buttons | Client navigation to the real notebook / ml-experiment / ml-model editor routes |
| Switcher entry | Cosmos `workloads-catalog` GLOBAL seed `homeHref` → `workload-hub` router push |

## No-Fabric-dependency note

Every backend on the default path is Azure-native (Cosmos + Azure Machine
Learning ARM). Nothing reads `fabricWorkspaceId` or
`LOOM_DEFAULT_FABRIC_WORKSPACE`. The page renders fully with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset; notebooks come from Cosmos and the
experiment/model strips read AML or show the honest Azure infra-gate.

## Bicep / bootstrap sync

No new Azure resource, env var, role, or Cosmos container. The only seeded
change is the `homeHref` field on the existing `wl-data-science` GLOBAL workload
doc, added to both seeding paths:
- `apps/fiab-console/app/api/admin/bootstrap-catalogs/route.ts` (in-VNet POST)
- `scripts/csa-loom/seed-catalogs.sh` (CLI seed)

AML wiring (`LOOM_SUBSCRIPTION_ID` / `LOOM_FOUNDRY_RG` / `LOOM_FOUNDRY_NAME` +
the Console UAMI "AzureML Data Scientist" role) is the same infra the existing
`ml-model` / `ml-experiment` editors already require — no new bicep.
