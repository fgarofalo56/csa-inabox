# report-powerbi-copilot — parity with the Power BI report-view Copilot pane

Source UI: the **Copilot pane** docked in the Power BI report editor (Power BI
Desktop / Power BI service report view) — the chat surface that builds a report
from the bound semantic model: suggest pages/visuals, add a visual on approval,
answer report-authoring questions, grounded on the model's real fields (never
hand-written DAX). Learn:
- Power BI Copilot introduction — <https://learn.microsoft.com/power-bi/create-reports/copilot-introduction>
- Create a report with Copilot (service) — <https://learn.microsoft.com/power-bi/create-reports/copilot-create-report-service>
- Power BI Copilot pane in report view — <https://learn.microsoft.com/power-bi/create-reports/copilot-create-report-service#use-copilot-in-the-report-view>

This surface is the **Power BI Copilot tab of the Loom report DESIGNER**
(`report-visual-designer.md` is the manual Visualizations+Fields canvas; this
doc is the Copilot that BUILDS on that same canvas). It is distinct from
`report-copilot.md`, which is the read-only narrative/suggested-visual panel on
the Loom-native report *viewer*; this one is wired into the **authoring** designer
and can place visuals and pages on approval.

**No Microsoft Fabric / Power BI dependency on the default path**
(`.claude/rules/no-fabric-dependency.md`): the acting path is the Loom-native
Azure Analysis Services designer + Synapse-backed report tools. The Power BI
remote MCP is a strictly **opt-in** enhancement (`powerbi-agentic-mcp.md`) that
only adds a live query/DAX tool surface when configured.

## Loom surfaces (file map)

| Loom file | Role |
| --- | --- |
| `lib/components/report/report-powerbi-copilot.tsx` -> `ReportPowerBiCopilot` | The Fluent v9 + Loom-token Copilot pane: streamed chat, Apply cards for proposed visuals/pages, honest opt-in MCP + AOAI gates, quick prompts. Owns the `CopilotVisualSpec` / `CopilotWellField` contracts the designer imports. |
| `app/api/items/report/[id]/powerbi-copilot/route.ts` | Thin SSE route. Builds a SCOPED registry (`buildReportTools` + `buildReportDesignerActTools` + select cross tools), runs `buildMcpShim(reg, userOid)` itself, composes the persona + acting instructions + live field grounding + Power BI skills + Microsoft skills, and streams `OrchestratorStep` over the shared `orchestrate()`. Emits an opening `meta` event with the honest gate. |
| `lib/copilot/report-designer-tools.ts` -> `buildReportDesignerActTools` (`report_designer_add_visual` / `report_designer_add_page`) | Pure validator/emitter tools: validate a STRUCTURED visual/page spec (reject unknown types and wells that name neither a real column nor measure) and echo it as a `tool_result` — no server mutation, no network. |
| `lib/editors/report-designer.tsx` -> `applyCopilotVisual` / `addCopilotPage` + the Build / Power BI Copilot `TabList` | The right rail's two-tab mount (Build = existing Visualizations+Fields verbatim; Power BI Copilot = the pane). The apply handlers map a `CopilotVisualSpec` -> a `DVisual` (wells re-UID'd) and add it to the active page via the existing `mutatePage`, which live-renders via `…/query` and persists on Save -> `…/definition`. |

## Azure/Fabric feature inventory (Power BI report-view Copilot)

| # | Capability (Power BI Copilot) | Where in Power BI |
|---|---|---|
| 1 | A dockable Copilot pane in the report editor's right rail | Report view -> **Copilot** button |
| 2 | Natural-language report-building / Power BI authoring chat | Copilot pane chat box |
| 3 | Suggest pages / visuals for the report from the bound model | "Suggest content for this report" / "Create a page" |
| 4 | Add a suggested visual to the canvas on approval (it renders) | Copilot proposes -> user adds -> visual draws |
| 5 | Add a new report page | "Add a page" |
| 6 | Ground every suggestion on the model's REAL fields (tables/columns/measures) | Copilot reads the bound dataset schema |
| 7 | No hand-written DAX — Copilot synthesizes the query from field wells | the visual's query is generated, not typed |
| 8 | Answer "how do I…" Power BI authoring questions (best-practice guidance) | Copilot conversational answers |
| 9 | Stream the assistant's reasoning + tool steps into the pane | live "working…" + result |
| 10 | Honest capability/availability state (Copilot not enabled in this tenant/region) | Copilot disabled banner |

## Loom coverage

Legend: built (real route/tool, day-one Azure-native) / honest-gate (Fluent
MessageBar naming the exact remediation; full surface still renders) / MISSING

| # | Inventory row | Status | Loom surface |
|---|---|---|---|
| 1 | Dockable Copilot pane in the right rail | built | `report-designer.tsx` Build / **Power BI Copilot** `TabList`; the whole rail stays collapsible via `ItemEditorChrome` (reuses the `CollapsedRail`/`CollapseToggle`/`useCollapsibleState` collapsible-side-panel primitives) |
| 2 | NL report-building / Power BI chat | built | `ReportPowerBiCopilot` -> `POST …/powerbi-copilot` -> shared `orchestrate()` with `REPORT_COPILOT_PERSONA` + `skillSystemBlocksForPane('report')` (the 5 Power BI authoring skills) + `msSkillSystemBlocksForPane('report')` (Microsoft skills) |
| 3 | Suggest pages / visuals from the model | built | planner/design skills + `report_query_model` (Synapse grounding) + `tabular_list_models/tables/measures`; the model proposes `report_designer_add_visual` specs |
| 4 | Add a suggested visual on approval -> renders | built | `report_designer_add_visual` -> pane **Proposed** Apply card -> `onApplyVisual(spec)` -> designer `applyCopilotVisual` maps spec->`DVisual` -> `mutatePage` -> live render via `POST …/query` (DAX SUMMARIZECOLUMNS over AAS) |
| 5 | Add a new report page | built | `report_designer_add_page` -> Apply card -> `onAddPage(name)` -> designer `addCopilotPage` |
| 6 | Ground on the model's REAL fields | built | designer forwards the `…/fields` table/column/measure list in the request `body.fields`; the route `serializeFields()` injects it into the system prompt; `report_designer_add_visual` **rejects** a well field that names neither a real column nor a measure |
| 7 | No hand-written DAX (structured wells only) | built | tools accept only `{table,column,measure,aggregation}` wells; `ACT_INSTRUCTIONS` forbid raw DAX/JSON; the designer synthesizes SUMMARIZECOLUMNS from the wells (`report-visual-designer.md`) |
| 8 | Power BI authoring Q&A (best-practice guidance) | built | the 5 `POWERBI_AUTHORING_SKILLS` injected via `skillSystemBlocksForPane('report', …)` + the curated Microsoft skills via `msSkillSystemBlocksForPane('report', …)` |
| 9 | Streamed reasoning + tool steps | built | SSE `step` events rendered as `tool_call` / `tool_result` (ok/fail + duration) / `thought` rows; `final` closes the bubble |
| 10 | Honest capability / availability state | honest-gate | **AOAI gate**: route returns `503` when no chat model is deployed -> pane MessageBar deep-links the Foundry CTA. **Opt-in MCP gate**: opening `meta` event carries `POWERBI_REMOTE_MCP_GATE_TEXT` when the remote Power BI MCP is not connected -> non-blocking MessageBar; the skills + designer-acting still work without it |

Zero MISSING, zero stub banners. The only non-functional states are honest gates
(one Azure infra-gate = AOAI deployment; one opt-in enhancement-gate = the Power
BI remote MCP), and the full pane renders in both.

## Backend per control

| Control | Backend |
|---|---|
| Send a turn | `POST /api/items/report/[id]/powerbi-copilot` -> `orchestrate()` (Azure OpenAI chat-completions, `cogScope()` cloud-correct) over a scoped `LoomToolRegistry` |
| Grounding narrative | `report_query_model` -> `executeQuery(dedicatedTarget(), sql)` (Synapse Dedicated SQL pool TDS, read-only guarded) |
| Model inspection | `tabular_list_models` / `tabular_list_tables` / `tabular_list_measures` / `tabular_eval_dax` (AAS / tabular layer) |
| "Add a visual" proposal | `report_designer_add_visual` — pure validation -> structured `DesignerVisualSpec` (no network) |
| "Add a page" proposal | `report_designer_add_page` — pure validation -> `{action:'add_page', name?}` (no network) |
| Apply visual (place + render) | `onApplyVisual` -> `applyCopilotVisual` -> `mutatePage` -> `POST /api/items/report/[id]/query` (DAX over the bound AAS model) |
| Apply page | `onAddPage` -> `addCopilotPage` (in-memory page add) |
| Field grounding source | `GET /api/items/report/[id]/fields` (real TMSCHEMA Discover, already loaded by the designer; forwarded to the route) |
| Persist | designer **Save** -> `PUT /api/items/report/[id]/definition` (Cosmos) |
| Opt-in live Power BI tools | `mcp_powerbiremote_*` auto-registered by `buildMcpShim` when `isPbiMcpConfigured()` + `getPbiUserToken(userOid)` hold (real Streamable-HTTP under the user's Entra OBO bearer — `powerbi-agentic-mcp.md`) |

No mock arrays: every control hits a real route/tool. `report_designer_add_*`
intentionally perform no server mutation — they are pending-diff emitters (like
the dataflow-copilot pending-diff cards); the **Apply** click drives the real
`…/query` render and the **Save** drives the real `…/definition` persist.

## Routing detail (why a dedicated route, not the narrative one)

The pane posts to `…/powerbi-copilot` rather than `…/report/copilot` because the
designer Copilot needs three things the narrative route does not: (1) the FULL
report-pane skill set (`skillsForPane('report')` -> semantic-model / report-
authoring / design / planner / management) + the Microsoft skills, (2) the opt-in
Power BI remote MCP made available, and (3) the structured **designer-acting**
tools. The route builds a SCOPED registry and runs `buildMcpShim` **itself**
(`orchestrate` skips the shim for a scoped registry), and it deliberately does
**not** pass `contextSlug` — so every tool in the scoped registry is advertised
to the model and the skills are injected manually into the system prompt.

## no-fabric-dependency posture (verification)

- **Default acting path is Loom-native**: AAS designer + Synapse-backed
  `report_query_model` / `tabular_*`. With `LOOM_DEFAULT_FABRIC_WORKSPACE` unset
  the pane fully works — chat, suggest, add-visual-on-Apply -> `…/query` render ->
  Save. No `fabricWorkspaceId` read on the default path.
- The remote Power BI MCP (`api.fabric.microsoft.com/v1/mcp/powerbi`) is the SOLE
  Fabric/Power BI host this surface can touch, and only when
  `isPbiMcpConfigured()` is true AND the user holds a cached delegated token.
  Otherwise `buildMcpShim` registers nothing for it and the pane shows the honest
  `POWERBI_REMOTE_MCP_GATE_TEXT` banner (non-blocking).
- Acceptance grep (expect ZERO default-path hits — every reach is behind the
  opt-in gate / catalog descriptor):
  ```bash
  grep -rn "api.fabric.microsoft.com\|api.powerbi.com\|onelake.dfs.fabric" \
    apps/fiab-console/lib/components/report/report-powerbi-copilot.tsx \
    "apps/fiab-console/app/api/items/report/[id]/powerbi-copilot/route.ts" \
    apps/fiab-console/lib/copilot/report-designer-tools.ts
  ```

## no-freeform-config posture

The user never types DAX or JSON. The Copilot emits structured `{type, title,
wells:{category,values,legend}}` specs; the designer synthesizes the DAX. The
tools reject an unknown visual type and any well field that names neither a real
column nor a real measure, so a proposed visual can only reference the bound
model's actual schema.

## web3-ui posture

Fluent v9 + Loom tokens throughout (`tokens.spacing*` / `colorBrand*` /
`borderRadiusLarge` / `shadow4`): elevated **Proposed -> Applied** Apply cards
with a `Badge`, an icon per affordance (`Sparkle`/`DataBarHorizontal`/
`DocumentAdd`/`Wrench`/`CheckmarkCircle`), streamed step rows, quick-prompt
chips, and a context caption (page / visual count / table count). The rail
matches its sibling rails via the shared `ItemEditorChrome` collapsible chrome.

## Per-cloud

| Cloud | AOAI scope | Synapse / AAS | Power BI remote MCP |
|---|---|---|---|
| Commercial | `cognitiveservices.azure.com/.default` (`cogScope()`) | Dedicated SQL pool TDS + AAS designer | opt-in only |
| GCC | same Commercial Azure endpoints | same | opt-in only |
| GCC-High / IL5 (AzureUSGovernment) | `cognitiveservices.azure.us/.default` (`cogScope()` gov branch) | Gov Synapse / AAS endpoints | Power BI MCP is a Commercial-only preview host — stays gated; the Azure-native acting path is the only path and remains fully functional |

## Verification

- `tsc --noEmit` clean on all four changed files (repo error count unchanged at
  the pre-existing 181 baseline; 0 in changed files).
- No-Fabric: the three acceptance greps above return zero default-path hits.
- Functional walk (the no-scaffold receipt — click every control):
  1. Open a report -> designer right rail -> **Power BI Copilot** tab.
  2. "add a bar chart of total revenue by region" -> a **Proposed** Apply card
     appears (`report_designer_add_visual` `tool_result`) showing the wells.
  3. **Add to canvas** -> `onApplyVisual` adds the `DVisual`; the canvas
     live-renders it via `POST …/query` (real DAX over the AAS model).
  4. "add a page" -> **Add page** card -> `onAddPage` adds the page.
  5. **Save** -> `PUT …/definition` persists the new visual + page to Cosmos.
  6. With AOAI undeployed: the pane shows the honest 503 Foundry gate. With the
     Power BI remote MCP unconfigured: the non-blocking opt-in MCP banner shows
     and steps 2-5 still succeed Azure-native.

## Follow-ups (honest)

1. A Vitest for `report-designer-tools.ts` validation (unknown type rejected;
   well that names neither a real column nor measure rejected; empty-wells
   rejected; valid spec echoed).
2. A `loom-uat` click-through of the add-bar-chart -> Apply -> render -> Save loop
   against a live AAS-bound report.
3. The opt-in remote-MCP scoped-persona prefix wrinkle tracked in
   `powerbi-agentic-mcp.md` (Known wrinkles) also governs whether the
   `mcp_powerbiremote_*` tools surface here once connected; this route advertises
   every scoped-registry tool (no `contextSlug`), so it is unaffected by the
   `toolPrefixes` filter gap — but the underlying `buildMcpShim` name-vs-constant
   reconciliation is the shared fix.
