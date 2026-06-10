# semantic-model-bulk-describe — parity with Fabric "AI Auto-Description for Semantic Models"

Source UI: Microsoft Fabric — OneLake catalog item detail → semantic model →
"Generate descriptions for all tables/measures" (Fabric Build 2026 announcement
#36, "AI Auto-Description for Semantic Models Preview"). Per-measure
auto-description already shipped in Loom via the DAX Copilot
(`dax_describe_model`); this adds the **bulk** catalog surface.

## Fabric feature inventory

| # | Fabric capability | Notes |
|---|-------------------|-------|
| 1 | Bulk "generate descriptions" entry point from the catalog/model detail | One action covers the whole model |
| 2 | AI-generated description per **table** | Business-friendly, grounded in table name/role |
| 3 | AI-generated description per **column** | Grounded in column name + table |
| 4 | AI-generated description per **measure** | Grounded in name + DAX expression |
| 5 | Review + edit proposals before applying | Human-in-the-loop diff |
| 6 | Persist descriptions to the model metadata | Written into model.bim description slots |
| 7 | Show coverage (described vs total) | Progress feedback |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | ✅ built | `BulkDescribeAction` on the OneLake catalog detail (`app/catalog/[source]/[id]`) for `SemanticModel` assets, and on the semantic-model editor's Measures/Model surface (`phase3-editors.tsx`) |
| 2 | ✅ built | AOAI generates a per-table description (`generateProposals`) |
| 3 | ✅ built | AOAI generates per-column descriptions, validated against the real model columns |
| 4 | ✅ built | AOAI generates per-measure descriptions, validated against the Loom model-store measures |
| 5 | ✅ built | `apply:false` returns proposals → editable Fluent textareas → `apply:true` persists the edited set |
| 6 | ✅ built | Table/column → `semantic-model-store` (Cosmos `tenant-settings`); measures → `model-store` (`item.state.model.measures[*].description`). Emitted into model.bim at provision time; opt-in live push via AAS XMLA Alter Table/Column |
| 7 | ✅ built | `GET` returns `counts { tables, tablesDescribed, columns, measures, measuresDescribed }`, shown as Fluent Badges |

Zero ❌. No stub banners.

## Backend per control

- **Generate / Apply** → `POST /api/items/semantic-model/[id]/describe-bulk`
  - Generator: **Azure OpenAI** chat completion (`response_format: json_object`),
    resolved via `resolveAoaiTarget` (env `LOOM_AOAI_ENDPOINT` /
    `LOOM_AOAI_DEPLOYMENT` → tenant Copilot config → Foundry discovery). Token
    via the Console UAMI (`Cognitive Services OpenAI User`).
  - Tables read from the Loom content (default; `pbi-content-fallback`) or, for
    an opt-in live Power BI / Fabric dataset id, `listDatasetTables`.
  - Measures read from the Loom `model-store`.
  - Persistence: `semantic-model-store.upsertTableDescriptions` (table/column) +
    `model-store.writeModelState` (measures). **Azure-native default — no Fabric
    / Power BI workspace required.**
  - Opt-in live push: AAS XMLA `command()` Alter Table / Alter Column with a
    `description` (only when `LOOM_AAS_SERVER_URL` / `LOOM_POWERBI_XMLA_ENDPOINT`
    is set; never required, failure never fails the request).
- **Coverage counts** → `GET /api/items/semantic-model/[id]/describe-bulk`.

## No-Fabric verification

With `LOOM_DEFAULT_FABRIC_WORKSPACE` unset and no Power BI workspace bound, a
Loom-native (`loom:…`) semantic model still lists its tables (from content) and
measures (from the model-store), the bulk action generates descriptions via
AOAI, and they persist to Cosmos — no `api.fabric.microsoft.com` /
`api.powerbi.com` call on the default path. When AOAI is not configured the
route returns an honest 502 with the exact env vars + role to set.
