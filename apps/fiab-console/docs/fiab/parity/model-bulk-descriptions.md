# model-bulk-descriptions — parity with Fabric "Generate descriptions for all" (semantic model / Model view)

Source UI: Microsoft Fabric **Build 2026 #36** — the semantic-model Model-view
catalog action *"Generate descriptions for all tables and measures"*: a single
button that drafts AI descriptions for every measure and table in the model,
then lets the author review/edit and apply them in bulk. Power BI / Fabric
Copilot exposes per-measure description authoring; this is the model-wide bulk
catalog surface.

Loom surface: the Loom-native **Model view** (`ModelViewPanel` in
`lib/editors/components/model-view-canvas.tsx`) used by the **Warehouse**,
**Synapse Dedicated SQL pool**, and **Databricks SQL Warehouse** editors →
Measures panel → **Generate descriptions** button → review dialog → **Save
descriptions**.

Backend: `POST /api/items/<engine>/[id]/model?kind=describe-all` and
`?kind=save-descriptions`, dispatched by the shared
`app/api/items/_lib/model-describe.ts`. AI backend is `lib/copilot/dax-describe.ts`
(the SAME Azure OpenAI path the per-measure DAX Copilot uses). Descriptions are
persisted Azure-native in Cosmos (`item.state.model.measures[*].description` and
`item.state.model.tableDescriptions[<tableId>]`).

> **No Power BI / Fabric on the default path.** The bulk action drafts via Azure
> OpenAI (env `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT`, UAMI "Cognitive
> Services OpenAI User") and persists to Cosmos. Zero `api.powerbi.com` /
> `api.fabric.microsoft.com` calls. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
> UNSET. When AOAI isn't configured the dialog renders an honest infra-gate
> MessageBar naming the env var/role — never a dead button.

## Fabric feature inventory (Build 2026 #36)

| # | Capability (source UI) | What it does |
|---|------------------------|--------------|
| 1 | Single "Generate descriptions for all" action | One click drafts descriptions for the whole model |
| 2 | Covers measures | AI description per measure, grounded on its expression |
| 3 | Covers tables | AI description per table, grounded on its columns |
| 4 | Review before apply | Author edits / accepts / rejects each proposal |
| 5 | Bulk apply | Save all accepted descriptions at once |
| 6 | Descriptions persist as model metadata | Show inline in the model catalog afterwards |
| 7 | Consistent with per-object AI authoring | Same model/quality as single-measure Copilot |

## Loom coverage

| # | Capability | Status | Loom implementation |
|---|------------|--------|---------------------|
| 1 | Single bulk action | ✅ built | "Generate descriptions" button in the Measures panel → `POST …?kind=describe-all` |
| 2 | Covers measures | ✅ built | `proposeMeasureDescriptions()` over `model.measures` (real AOAI, JSON mode) |
| 3 | Covers tables | ✅ built | `proposeTableDescriptions()` over the live tables (Synapse `sys.tables` / UC `DESCRIBE`) |
| 4 | Review before apply | ✅ built | Review dialog with per-row checkbox + editable `Textarea`; nothing written until Save |
| 5 | Bulk apply | ✅ built | `POST …?kind=save-descriptions` → `applyDescriptions()` → `writeModelState()` (Cosmos) |
| 6 | Persist + show inline | ✅ built | Measures table gains a **Description** column; tables carry `description` on GET (stamped from `tableDescriptions`) |
| 7 | Consistent w/ per-object | ✅ built | Shares `lib/copilot/dax-describe.ts` with the `dax_describe_model` Copilot tool — same backend, same prompts |
| — | Honest AI infra-gate | ⚠️ gate | No `LOOM_AOAI_*` → `{ aiUnavailable: true }` (200) → warning MessageBar with the exact env var + RBAC docs link |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Generate descriptions (measures) | Azure OpenAI chat (`dax-describe.proposeMeasureDescriptions`) via UAMI token (`cogScope()`, cloud-aware) |
| Generate descriptions (tables) | Azure OpenAI chat (`dax-describe.proposeTableDescriptions`) over live table schema read from Synapse Dedicated (`sys.tables`) or Databricks Unity Catalog (`DESCRIBE TABLE`) |
| Save descriptions | Cosmos `items` container — `writeModelState` (`item.state.model`), Azure-native, no Power BI / Fabric |
| Inline display | Model `GET` returns `measures[*].description` + `tableDescriptions`; the panel renders them |

## No new infra

Reuses the existing `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` env (already
wired in `platform/fiab/bicep/modules/admin-plane/main.bicep`) and the Console
UAMI's existing "Cognitive Services OpenAI User" grant. No new env var, role, or
Cosmos container — the per-measure DAX Copilot already exercises this backend.

## Verification

- `tsc --noEmit` clean on all touched files.
- Unit tests: `lib/copilot/__tests__/dax-describe.test.ts` (proposal JSON
  parsing) + `app/api/items/_lib/__tests__/model-store.test.ts`
  (`applyDescriptions` measure/table merge + counts).
- Live: with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, open a Warehouse / Databricks
  SQL Warehouse Model view, click **Generate descriptions**, review, **Save**,
  reload — the Description column and table descriptions persist.
