# report-copilot — parity with Power BI Copilot (report narrative + suggested visuals)

Source UI: Power BI Copilot in the report canvas — "Create a narrative" /
"Suggest content for this page"
(https://learn.microsoft.com/power-bi/create-reports/copilot-create-report-service)
and Fabric Copilot for report authoring. CSA Loom builds the SAME capability
**Azure-native**: the narrative is grounded on the Loom tabular semantic layer
(Synapse Dedicated SQL pool) via Azure OpenAI, and the suggested visual is added
to the Loom-native report. **No Power BI / Microsoft Fabric dependency on the
default path** (no-fabric-dependency.md).

## Azure/Fabric feature inventory (Power BI Copilot, report authoring)

1. Generate a narrative summary of the report / page data in natural language.
2. Ground the narrative on the report's real underlying data (aggregates), not invented numbers.
3. Suggest a visual to add to the page (type + fields).
4. Add the suggested visual to the report on approval, so it renders.
5. Stay scoped to the open report's bound dataset / model.
6. Stream the assistant's reasoning + result into the authoring surface.

## Loom coverage

| # | Capability | Status | Loom surface |
|---|------------|--------|--------------|
| 1 | Narrative summary of report data | built | `ReportCopilotPanel` final-answer card; `REPORT_COPILOT_PERSONA` system prompt |
| 2 | Grounded on REAL aggregates (no invented numbers) | built | `report_query_model` -> `executeQuery(dedicatedTarget(), sql)` (Synapse Dedicated SQL pool); persona forbids inventing numbers |
| 3 | Suggest a visual (type + title + field) | built | `report_suggest_visual` -> validated `ReportVisualSuggestion` (barChart/columnChart/lineChart/pieChart/tableEx/card/areaChart) |
| 4 | Add the visual on approval -> renders | built | `POST /api/items/report/[id]/visual` writes `state.content.pages[].visuals[]`; Loom-native viewer (`reportPagesFromContent`) renders the tile |
| 5 | Scoped to the bound report + its model | built | panel binds to the report item's Cosmos id; BFF loads the bound item for grounding context |
| 6 | Streamed reasoning + result | built | SSE from `POST /api/items/report/copilot` (persona-scoped 2-tool registry over the shared `orchestrate()` engine) |

Zero MISSING, zero stub banners. The only non-functional state is the honest
AOAI gate (MessageBar intent="warning") when no Copilot chat model is deployed —
the full panel still renders.

## Backend per control

| Control | Backend |
|---------|---------|
| "Generate narrative & visual" | `POST /api/items/report/copilot` -> `orchestrate()` with `REPORT_COPILOT_PERSONA.systemPrompt` + persona registry -> Azure OpenAI chat-completions (`cogScope()`, cloud-correct) |
| `report_query_model` | Synapse Dedicated SQL pool TDS — `executeQuery(dedicatedTarget(), capSql(sql))`, read-only guarded (`assertReadonly`) |
| `report_suggest_visual` | pure validation -> structured suggestion (no external call) |
| "Add to report" | `POST /api/items/report/[id]/visual` -> Cosmos `items` replace via `updateOwnedItem` (state.content) |
| Loom-native content viewer | `GET /api/items/report/loom:<id>/pages` -> `reportPagesFromContent` (Cosmos) |

## Per-cloud

| Cloud | AOAI scope | Synapse | Power BI / Fabric |
|-------|-----------|---------|-------------------|
| Commercial | `cognitiveservices.azure.com/.default` (`cogScope()`) | Dedicated SQL pool TDS | opt-in only; never on default path |
| GCC | same Commercial Azure endpoints | same | opt-in only |
| GCC-High / IL5 (AzureUSGovernment) | `cognitiveservices.azure.us/.default` (`cogScope()` gov branch) | Gov Synapse endpoint | Power BI not available — Loom-native is the ONLY path |

## No-Fabric verification

`POST /api/items/report/copilot` and `POST /api/items/report/[id]/visual` make
zero calls to `api.powerbi.com` / `api.fabric.microsoft.com` on the default
path. The narrative + visual are produced entirely from Azure OpenAI + Synapse +
Cosmos, and the visual renders in the Loom-native report viewer with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Verification

- `lib/copilot/__tests__/report-tools.test.ts` — 9 tests GREEN (tool shape,
  read-only guard, SQL capping, visual validation, suggestion coercion).
- `tsc --noEmit` clean on all touched files.
