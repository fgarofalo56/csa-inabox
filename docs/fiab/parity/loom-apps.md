# loom-apps — parity with Microsoft Fabric "Apps"

Source UI:
- Fabric org apps / Power BI apps — https://learn.microsoft.com/fabric/fundamentals/create-apps , https://learn.microsoft.com/power-bi/consumer/end-user-apps , audiences: https://learn.microsoft.com/power-bi/collaborate-share/service-create-distribute-apps
- Fabric data apps (Rayfin, Build 2026) — https://learn.microsoft.com/fabric/apps/overview

Fabric's "Apps" surface spans **two distinct shapes**, and CSA Loom covers both on an
Azure-native / OSS stack with **no Microsoft Fabric or Power BI workspace dependency**
(`.claude/rules/no-fabric-dependency.md`). The catalog category is displayed as
**"Loom Apps"** (internal workload key `fabric-apps` kept stable for back-compat).

---

## 1. Org app — bundle workspace items into a distributable app  (`loom-app`, NEW)

The classic "Fabric app / Power BI app": package existing workspace items into a
packaged, distributable app with an **audience** and **navigation** for consumers.

### Fabric feature inventory (grounded in Learn)

| Fabric capability | Notes |
|---|---|
| Add content — pick workspace items (reports, dashboards, notebooks, …) to include | "Create apps" — select items |
| Navigation — arrange content into sections + order | App navigation builder |
| Audiences — multiple named audiences, each with its own access list | "Create and distribute apps" → audiences |
| Per-audience content scope — an audience sees a subset of the app content | Audience content selection |
| Publish / update — publish the app; consumers open it | Publish app |
| Consumer view — audience-filtered navigation, open each item | End-user app experience |

### Loom coverage

| Capability | Status | Where |
|---|---|---|
| Add content from the live workspace inventory | built ✅ | Content tab → `GET /api/items/loom-app/[id]/candidates` (real Cosmos `listAllOwnedItems`) |
| Order content (move up/down) | built ✅ | Content tab |
| Navigation sections (add / remove / reorder) + per-item section | built ✅ | Navigation tab + Content tab section dropdown |
| Audiences (add / remove / rename) | built ✅ | Audiences tab |
| Per-audience access list (user email / UPN / oid / group id) | built ✅ | Audiences tab; resolved in `render` against session claims |
| Per-audience visible-content subset (all or a chosen subset) | built ✅ | Audiences tab checkboxes |
| Publish / re-publish / unpublish + version | built ✅ | Publish tab → `POST /api/items/loom-app/[id]/publish` (Cosmos write) |
| Consumer app view (audience-filtered nav, deep-link to real items) | built ✅ | `/apps/view/[id]` → `GET /api/items/loom-app/[id]/render` |
| In-editor Preview (resolve the exact consumer manifest) | built ✅ | Preview tab → `render` |

### Backend per control

| Control | Backend |
|---|---|
| Load / save definition | `GET`/`PATCH /api/items/loom-app/[id]` (`makeItemRoute`, Cosmos `state`) |
| Content picker inventory | `GET …/candidates` → `listAllOwnedItems(oid, workspaceId)` (Cosmos, ownership-scoped) |
| Publish / unpublish | `POST …/publish` → `updateOwnedItem` (Cosmos) |
| Consumer render / preview | `GET …/render` → `loadOwnedItem` + `listAllOwnedItems` + `resolveVisibleContent` (session-claim audience match) |

No Fabric / Power BI host is called on any path. Access reuses Loom's item ownership
+ workspace access model (`resolveWorkspaceAccessByOid`).

---

## 2. Data app — data-driven app on an Azure-native backend  (`rayfin-app` → "Data app")

Fabric's Rayfin data-app shape (Build 2026): build an application over your data.
The Loom "Data app" is a **backed template** that scaffolds a runnable Azure-native
stack — **Azure Functions** (API) + **Cosmos DB** (store) + **Static Web App** (web) —
wired together, each a real editable Loom item. Previously Labs-hidden; now creatable
from the New-item gallery (Preview badge retained).

| Capability | Status | Where |
|---|---|---|
| Scaffold Functions + Cosmos + SWA, wired | built ✅ | app-template `rayfin-azure-stack` → `/api/app-templates/[id]/instantiate` |
| Visual app builder runtime over a bound model | built ✅ | `rayfin-app-editor` + `POST /api/items/rayfin-app/[id]/render` (Azure Analysis Services) |
| Opt-in Fabric Rayfin SDK/CLI path | disclosed | learnContent note only; never the default |

Related ontology-app builders also live under **Loom Apps**: **Slate app** (Palantir
Slate parity, scaffolds Workshop + Data API Builder → Azure Static Web Apps) and
**Workshop app** (Palantir Workshop parity, ontology-bound low-code app on Azure
Container Apps). Both Azure-native, no Fabric.

---

## Removed: Azure Data Lake Analytics category

ADLA (retired 2024-02-29) had an **empty** New-item category. The dead
`'Azure Data Lake Analytics'` workload category was removed from the catalog
(`item-types/types.ts`, `fabric-item-types.ts`, `workload-hub.ts`, `item-type-icon.tsx`).
The ADF pipeline **U-SQL activity** (`lib/components/pipeline/activity-catalog.ts`) and the
U-SQL editor's retirement MessageBar are **kept** — those are a legit Data Factory
activity + an honest deprecation notice, not a creatable item.

## Verification

- `GET /api/items/loom-app/<id>/candidates` returns the real workspace inventory.
- Add items → Save (`PATCH …`) → Publish (`POST …/publish` → `{ok, url:/apps/view/<id>, version}`).
- `/apps/view/<id>` resolves the audience-filtered nav; each tile deep-links to the live item.
- Guard cascade (bff-errors, route-guards, no-freeform, no-raw-px, no-bare-client-fetch, …) green.
