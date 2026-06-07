# data-pipeline-export-import — parity with ADF Studio Export/Import + Template gallery

Source UI:
- ADF Studio "Export template" / "Import template" (pipeline … menu) and ARM
  `factories/{f}/pipelines/{name}` GET/PUT — https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities
- ADF Studio template gallery — https://learn.microsoft.com/azure/data-factory/solution-templates-introduction
- Delta copy with control table — https://learn.microsoft.com/azure/data-factory/solution-template-delta-copy-with-control-table
- Metadata-driven copy — https://learn.microsoft.com/azure/data-factory/copy-data-tool-metadata-driven

Covers Fabric-parity backlog items **F3 (Export/Import)** and **F28 (Template gallery)**.

## Azure/Fabric feature inventory

| # | Capability (ADF Studio / Fabric) | Notes |
|---|----------------------------------|-------|
| 1 | Export a pipeline to a downloadable archive (ADF Studio "Export template" → `.zip` carrying the pipeline JSON) | Studio builds the archive client-side from the ARM GET response |
| 2 | The exported file is the canonical pipeline JSON (`{ name, properties: { activities[], parameters, … } }`, api-version 2018-06-01) | Re-importable into Studio or another factory |
| 3 | Import a pipeline from an exported archive (unzip → validate → create) | Studio "Import template" |
| 4 | Imported pipeline lands as a NEW pipeline (import never silently overwrites) | |
| 5 | Imported pipeline opens on the canvas identical to the source (all activities + dependencies + parameters) | |
| 6 | Save/Publish the imported pipeline to the live factory | ARM PUT |
| 7 | Template gallery flyout listing curated, ready-to-run patterns | ADF Studio "Pipeline templates" |
| 8 | Curated Copy patterns: single Copy, ForEach bulk copy, watermark incremental, metadata-driven control-table copy | The four canonical ADF solution templates |
| 9 | Instantiating a template pre-fills the canvas with real, editable nodes (not a preview image) | |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | ✅ built | `app/api/items/data-pipeline/[id]/export/route.ts` (GET → `writeZip`) + `Export` ribbon action in `lib/editors/data-pipeline-editor.tsx` |
| 2 | ✅ built | Export packages `pipeline-content.json` = the ADF 2018-06-01 spec from `getPipeline` → `state.definition` → `pipelineDefinitionFromContent`, plus a `manifest.json` |
| 3 | ✅ built | `app/api/items/data-pipeline/import/route.ts` (POST multipart → `readZip` → `isPipelineSpec` guard → `upsertPipeline` → Cosmos create) |
| 4 | ✅ built | Import always `items.items.create()` with a fresh `crypto.randomUUID()` |
| 5 | ✅ built | New item carries `state.definition`; the editor's existing detail GET resolution chain renders the full canvas |
| 6 | ✅ built | Existing PUT `[id]/route.ts` publishes; import also publishes to ADF when configured |
| 7 | ✅ built | `lib/components/pipeline/templates/gallery.tsx` (OverlayDrawer) + `Templates` ribbon action |
| 8 | ✅ built | `lib/components/pipeline/templates/catalog.ts` — 4 templates, all activity types resolve to runnable `ACTIVITY_CATALOG` entries |
| 9 | ✅ built | `instantiateTemplate` → `patchSpec(() => templateSpec)` — same mutation path as drag-from-palette; nodes are real + editable |
| — | ⚠️ honest gate | When ADF env vars (`LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` / `LOOM_ADF_NAME`) are unset, import still saves to Loom (Cosmos) and the response `gate` drives a precise toast naming the missing var. Export falls back to `state.definition` so it works with ADF unconfigured. |

Zero ❌. Zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Export | `GET /api/items/data-pipeline/[id]/export` → Cosmos read + `getPipeline` (ARM) → `writeZip` (node:zlib PKZIP, no new dep) → streamed `application/zip` |
| Import | `POST /api/items/data-pipeline/import` (multipart) → `readZip` → shape-validate → `upsertPipeline` (ARM PUT) when configured → `itemsContainer().items.create` |
| Templates flyout | Static module `PIPELINE_TEMPLATES` (4 entries) — cannot render empty |
| Template instantiate | `patchSpec` (client) → Save → existing PUT → ARM `upsertPipeline` |

## No-Fabric / sovereign-cloud

- No Fabric/Power BI REST host is touched on any path — export-read and
  import-publish go through `adf-client.ts` (ARM) only. Works with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- `adf-client.ts` ARM host is now sovereign-cloud aware (`armBase()` reads
  `AZURE_CLOUD` / optional `LOOM_ARM_ENDPOINT`): Commercial default
  `management.azure.com`, GCC-High `management.usgovcloudapi.net`, IL5
  `management.azure.microsoft.scloud`. Default behavior is unchanged. This
  fixes a pre-existing gap that affected every ADF call, not just export/import.

## Bicep sync

No new Azure resource, env var, role, or Cosmos container. The feature reuses
the existing ADF wiring (`LOOM_SUBSCRIPTION_ID`, `LOOM_DLZ_RG`, `LOOM_ADF_NAME`
already in `platform/fiab/bicep/modules/admin-plane/main.bicep`) and the
existing `items` container. `AZURE_CLOUD` is already consumed by `msal.ts`;
`LOOM_ARM_ENDPOINT` is an optional override with a safe default.

## Verification (real-data E2E)

- `tsc --noEmit` clean (0 errors repo-wide).
- `vitest run lib/azure/__tests__/zip.test.ts lib/components/pipeline/templates/__tests__/catalog.test.ts` → 8/8 pass (PKZIP byte-for-byte round-trip incl. deflate + multi-entry; every template activity type resolves to a runnable catalog entry; non-empty gallery; corrupt-ZIP rejection).
- Manual: Export a real pipeline → `.zip` downloads; Import that `.zip` → new pipeline with identical canvas; Save (PUT) succeeds; each template instantiates real, editable nodes.
