# copilot-result — parity with rich tool-result rendering (Azure ML Studio / Fabric Data Agent answer cards)

Source UI: Azure portal query editors (Synapse / ADX results grid), Microsoft
Fabric Data Agent + Copilot answer cards (table / chart / code / explanation),
and AI Foundry playground tool-call rendering.
Learn refs: https://learn.microsoft.com/azure/data-explorer/web-query-data ·
https://learn.microsoft.com/fabric/get-started/copilot-fabric-overview

## Azure/Fabric feature inventory (how rich assistants render tool output)

- Tabular tool output rendered as an interactive results grid (sortable,
  filterable, resizable columns, row count, truncation notice, export).
- Series output rendered as a chart with a toggle back to the grid.
- Generated code (SQL / KQL / Python / JSON) shown in a syntax-highlighted,
  read-only editor with Copy and "insert into the active editor".
- Natural-language explanations / summaries rendered as formatted markdown
  (headings, bold, lists, inline code) — not raw text or JSON.
- A change/receipt card when the assistant created or modified an object, with
  a link to open it.
- Errors surfaced as a clear inline banner, not a stack-trace dump.
- Raw payloads never shown to end users on the happy path.

## Loom coverage

| Capability | Status | Notes |
|---|---|---|
| Tabular result → interactive DataGrid (sort/filter/resize, row count, truncation, CSV copy) | ✅ | `TableRenderer` over `LoomDataTable`; columnar `rows[][]` zipped to row objects |
| Series result → chart with toggle to table | ✅ | `ChartRenderer` over existing `KqlChart` (SVG, no charting dep) + Table toggle |
| Generated code → read-only Monaco + Copy + Insert into editor | ✅ | `CodeRenderer` over self-hosted `MonacoTextarea` (`readOnly`); Insert broadcasts `loom:insert-code` and copies to clipboard |
| Explanation/summary → rendered markdown (headings/bold/lists/code/fences) | ✅ | `SummaryRenderer` — lightweight inline parser, zero new npm deps |
| Created/modified item → change-set receipt + Open link | ✅ | `ProposedChangeRenderer`; field/before/after table + working `/items/<type>/<id>` link |
| Tool error → inline error MessageBar | ✅ | `ErrorRenderer` (Fluent `MessageBar intent="error"`) |
| Raw JSON never shown to users on happy path | ✅ | Console `StepCard` + pane dispatch to `CopilotResult`; raw `<pre>` only via collapsible `UnknownResult` details for untaggable output |
| Clipboard works on hardened (IL5) browsers | ⚠️ | `copyText` falls back to `document.execCommand('copy')` when the async Clipboard API is blocked by policy |

Zero ❌, zero stub banners.

## Backend per control

The renderer is pure presentation over the REAL output the Azure-native tool
handlers already produced — no mocks, no new backend:

- table ← `synapse_serverless_query` / `synapse_dedicated_query` (Synapse TDS,
  `synapse-sql-client`), `databricks_run_warehouse_query` (Databricks SQL),
  `adx_query` (Kusto REST, `kusto-client`). Handlers tag results via
  `asTable(...)`.
- summary ← `loom_self_audit` (the live self-audit registry) via
  `asSummary(auditToMarkdown(report))`.
- code / chart / proposed_change ← any tool that emits the matching typed
  envelope; untagged/legacy output is classified by `tagResult()` heuristics at
  render time (idempotent on already-typed results).

## No-Fabric / per-cloud

No Fabric or Power BI dependency: every data source above is Azure-native and
works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. No new Azure resource, env
var, Cosmos container, or RBAC grant — this is UI enrichment over data the
orchestrator already fetches, so there is no bicep delta. Monaco is self-hosted
from `/monaco/vs` (CSP `script-src 'self'` safe in all clouds incl. GCC/GCC-High).
On IL5-hardened browsers the Copy / Insert clipboard write degrades to
`execCommand('copy')`.

## Verification

- `lib/components/__tests__/copilot-result-tagger.test.ts` — 11 passing node
  unit tests for the kind heuristic + constructors.
- `lib/components/__tests__/copilot-result.test.tsx` — one jsdom render test per
  kind (table renders real rows as a DataGrid, chart renders an SVG, code
  renders read-only Monaco + Copy/Insert, summary renders markdown heading +
  bold, proposed_change renders the change table + Open link, error renders the
  MessageBar, unknown renders a collapsible details).
