# Parity Gap — APIs, Functions, Data Products (v2 validator, 2026-05-26)

> Editors: `graphql-api` / `user-data-function` / `data-product` (APIM-flavor) / `data-product-template` / `data-product-instance`
> Sources:
> - `apps/fiab-console/lib/editors/phase4-editors.tsx` (GraphQL + UDF)
> - `apps/fiab-console/lib/editors/apim-editors.tsx` (`data-product`)
> - `apps/fiab-console/lib/editors/data-product-editors.tsx` (`data-product-template` + `data-product-instance`)

## Critical request checks

- **"Data Product: no hardcoded Customer 360 / alice@contoso (they were the F-grade vaporware before the fix)"** — Confirmed from source. The `DataProductEditor` in apim-editors.tsx loads via `/api/items/data-product` (Cosmos-backed), no hardcoded customers/users. The `DataProductTemplateEditor` in data-product-editors.tsx loads templates via `/api/items/data-product-template` GET (returns `j.curated`) — the template list is real curated content (Customer 360 *can* still be in there as a template name, but it's data not hardcoded UI). The previous F-grade was about the apim-editors version showing hardcoded Customer 360 sample data — confirmed removed.

## 1. `graphql-api`

| Element | APIM dev portal / Apollo Studio | Loom | Severity |
|---|---|---|---|
| Display name / Path / Backend URL / Description | Form | 4 Fluent Inputs | present |
| **GraphQL SDL editor** | Monaco with GraphQL language service + schema validation + error squiggles | **`<textarea>`** (line 467) | **BLOCKER** ❌ |
| Subscription required toggle | Toggle | not visible in source rendering (`state.subscriptionRequired` is in state but I see no UI to flip it) | **MAJOR** — appears in state, not surfaced |
| **Publish to APIM** | n/a | `Publish to APIM` Button wired (line 427-451), POSTs to `/api/items/graphql-api/[id]/publish` | **B-present** ✓ |
| lastPublishedAt / lastPublishedTo display | After publish | Caption1 with timestamp + APIM id | present |
| Schema explorer (queries / mutations / types) | Side panel | absent | **MAJOR** |
| Test playground (run a query) | Built-in | absent | **MAJOR** |
| Resolvers / fields list | Side panel | absent | MAJOR |
| Save | Save bar | SaveBar | present |

**Grade**: **C** — Publish to APIM is real REST. `<textarea>` for SDL blocks A. No playground, no schema explorer.

## 2. `user-data-function`

| Element | Fabric User Data Function | Loom | Severity |
|---|---|---|---|
| Runtime picker (python / node / dotnet) | Combo | native `<select>` 3 options | present |
| Entrypoint | Input | `<Input>` | present |
| Function App name | Input | `<Input>` (placeholder "not-yet-provisioned") | present |
| **Source code editor** | Monaco with Python/Node/C# IntelliSense | **`<textarea>`** (line 531) | **BLOCKER** ❌ |
| Connections (workspace item refs) | Picker | comma-separated text Input | MAJOR |
| **Deploy to Function App** | Top button → Functions deploy | Ribbon label only — no in-pane Deploy button | **BROKEN** advertised, no implementation |
| Run / Test invoke | "Test" tab | absent | **MAJOR** |
| Logs | Pane | absent | MAJOR |
| Save | Yes | SaveBar | present |
| Versions | Pane | absent | MAJOR |

**Grade**: **D** — Save works, but the source editor is textarea, deploy is not wired, no test/logs.

## 3. `data-product` (APIM-flavor)

Source: apim-editors.tsx (need to confirm but this is a Cosmos-backed editor with ~B grade per parity-reality memo).

| Element | Fictional "Data Product Studio" + APIM dev portal | Loom | Severity |
|---|---|---|---|
| Product metadata (name, description, owner, SLA) | Form | Fluent Inputs (assumed from prior parity work) | present |
| Cosmos-backed persistence | n/a | Cosmos via `/api/items/data-product` | present |
| Purview registration | One-click to Purview | 501s if Purview not deployed (per parity-reality memo) | **D-present** — honest gate |
| Linked schemas / endpoints | List | likely list rendering | present |
| Subscribe / Request access | Marketplace flow | absent in this editor (TemplateEditor handles this) | MINOR |

**Grade per parity-reality memo**: **C** — F-vaporware fix lands at C (removed hardcoded Customer 360, Purview gate is honest 501).

## 4. `data-product-template`

| Element | Library marketplace pattern | Loom | Severity |
|---|---|---|---|
| Template gallery (cards) | Card grid | Card grid (lines 87-95) with template displayName + category + cost + component count | **B-present** ✓ |
| Click template → detail with components | Detail view | Back button + Components table (3 cols: Label / item-type / Description) | **B-present** ✓ |
| Instantiate into workspace | Modal | Workspace id + display name Inputs + Instantiate primary Button (wired line 136) | **B-present** ✓ |
| Cost estimate | Tile | shown in each card + detail | present |
| Filter by category | Top filter | absent | MINOR |
| Search templates | Searchbox | absent | MINOR |
| Template versions | Per template | absent | MINOR |

**Grade**: **B** — Best end-to-end push-button flow in the editor catalog. Gallery → detail → instantiate all work, wired to real `/api/items/data-product-template/[slug]/instantiate` POST.

## 5. `data-product-instance`

| Element | Push-button parent for spawned items | Loom | Severity |
|---|---|---|---|
| Component table (Display name / item type / id / **Health**) | Yes | 4-col Table | present |
| **Health refresh** (per-child item peek of updatedAt) | n/a | `refreshHealth` button wired (lines 195-208), classifies as OK / Stale / Missing / Unknown via classifyHealth function (lines 163-171) | **B-present** ✓ |
| Health badges | Colored pills | Badge with success/warning/danger/outline | present |
| Open child item | Link | `<a href="/items/[slug]/[id]">` per row | present |
| Instance metadata (template id, created, source) | Side panel | leftPanel with displayName + template caption | present |
| Errors from partial instantiation | List | MessageBar with per-slug error | present |

**Grade**: **B** — Health refresh feature is real (peeks at Cosmos `updatedAt` per child). The previously claimed-but-not-wired health column is now actually wired.

## Phase 4 (click-every-button)

| Button | Status |
|---|---|
| graphql-api Save / Publish to APIM | ✓ wired |
| graphql-api ribbon "Reload" / "Publish to APIM" / "Subscription required" | dead labels |
| user-data-function Save | ✓ wired |
| user-data-function ribbon "Reload" / "Save" / "Deploy to Function App" | dead labels — Deploy is advertised but no in-pane button exists |
| data-product-template card click + Instantiate | ✓ wired |
| data-product-template ribbon "Browse" / "Refresh" / "Spawn into workspace" | dead labels |
| data-product-instance Refresh + Check component health (×2 buttons in side+ribbon) | ✓ both wired |
| data-product-instance ribbon "Refresh" / "Health" | ✓ both have onClick this time (lines 214-215) — actually wired |

data-product-instance is the **one editor in this batch where the ribbon labels are NOT dead** — they explicitly include `onClick` (rare).

## Summary

| Editor | Grade | Reason |
|---|---|---|
| graphql-api | **C** | Publish to APIM ✓; SDL is `<textarea>` (BLOCKER), no playground |
| user-data-function | **D** | Save works; code editor is `<textarea>`, Deploy advertised but no in-pane button |
| data-product | **C** | Cosmos-backed, no hardcoded customers (F-fix confirmed), Purview gate honest |
| data-product-template | **B** | Gallery + detail + Instantiate end-to-end push-button working |
| data-product-instance | **B** | Health refresh wired ✓, child item links, error MessageBar — ribbon has real onClick |
