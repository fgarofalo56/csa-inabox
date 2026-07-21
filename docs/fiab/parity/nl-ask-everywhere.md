# nl-ask-everywhere — WS-5.4 NL "Ask" affordance on ≥5 surfaces

Source UI: Copilot in Microsoft Fabric / Azure OpenAI grounded chat
Parity scope: Cross-cutting affordance — every data surface gets a consistent
"Ask" bar backed by the real `chatGrounded()` pipeline (data-agent-client.ts).

---

## Feature inventory (from Fabric / Azure portal references)

| # | Capability | Loom coverage | Backend |
|---|-----------|--------------|---------|
| 1 | Inline NL question bar on data grids / table previews | ✅ Built | `/api/ask` → `chatGrounded` → Synapse/ADLS |
| 2 | NL question bar on KQL dashboards | ✅ Built | `/api/ask` → `chatGrounded` → ADX |
| 3 | NL "Ask" tab in report designer right pane | ✅ Built | `/api/ask` → `chatGrounded` → semantic-model layer |
| 4 | NL "Ask" tab in semantic model editor | ✅ Built | `/api/ask` → `chatGrounded` → AAS/Synapse |
| 5 | NL "Ask" affordance on ontology object type browser | ✅ Built | `/api/ask` → `chatGrounded` → AGE/Cosmos ontology |
| 6 | Grounded answer with executed query results | ✅ Built | `DataAgentResultViz` — real rows/KPI tiles |
| 7 | Conversation history (multi-turn follow-ups) | ✅ Built | Client-side turns state, passed to backend |
| 8 | Type-badged column results in answer | ✅ Built | `DataAgentResultViz` renders tool `columns` |
| 9 | Timing / token status bar | ✅ Built | `durationMs` + `totalTokens` in response |
| 10 | Honest infra gate (AOAI not configured) | ✅ Built | 503 + `MessageBar` naming `LOOM_AOAI_ENDPOINT` |
| 11 | Keyboard accessibility (Enter / Escape) | ✅ Built | `onKeyDown` handlers in AskAffordance |
| 12 | No badge overlaps (flexWrap + minWidth:0) | ✅ Built | All badge/tag rows use layout tokens |
| 13 | Collapsed "Ask" button (low footprint) | ✅ Built | Single `Sparkle` button when not expanded |
| 14 | No Fabric dependency | ✅ Built | Azure-native path only; no fabricWorkspaceId |

---

## Surfaces wired

### Surface 1 — Table/grid preview (lakehouse + warehouse table views)

File: `lib/editors/components/delta-preview-grid.tsx`

Props added (all optional, non-breaking):
- `askSurfaceKind?: AskSurfaceKind`
- `askItemId?: string`
- `askItemType?: string`

Context forwarded: visible column names, row count in placeholder.

### Surface 2 — KQL dashboard

File: `lib/editors/phase3/kql-dashboard-editor.tsx`

Renders when tiles exist. Context: first 5 distinct KQL table names extracted
from tile queries.

### Surface 3 — Report designer (right pane "Ask" tab)

File: `lib/editors/report-designer.tsx`

Added `'ask'` tab to the `RightTab` union type and the right-pane TabList.
`alwaysOpen` so the input is immediately visible in the tab.
Context: all table names from the report's data model.

### Surface 4 — Semantic model editor ("Ask" tab)

File: `lib/editors/phase3/semantic-model-editor.tsx`

Added `'ask'` to the tab state union. New tab renders `AskAffordance` with
`alwaysOpen`. Context: model table names.

### Surface 5 — Ontology SDK editor (object type browser)

File: `lib/editors/palantir/ontology-sdk-editor.tsx`

Renders at the bottom of the editor when an ontology is bound.
Context: selected object type names (up to 10).

---

## Shared component

`lib/components/ask/AskAffordance.tsx`
- `AskSurfaceKind` union exported for surface consumers
- All styles via `tokens.*` — no hard-coded values
- `flexWrap` + `minWidth:0` on badge rows
- Keyboard: Enter submits, Escape closes
- Gate: `MessageBar intent="error"` on 503 (AOAI not configured)

## BFF route

`app/api/ask/route.ts`
- Session-guarded (`getSession()`)
- Maps `surfaceKind` → `DataAgentSourceType`
- Builds temporary `DataAgentConfig` from surface context (no Cosmos item required)
- Calls `chatGrounded(cfg, [], question, { tenantId })` — real two-phase AOAI pipeline
- Returns `{ ok, answer, tools, usage, model, durationMs }` or `{ ok: false, error, hint }`
- On `NoAoaiDeploymentError`: 503 with hint to set `LOOM_AOAI_ENDPOINT` / deploy gpt-4o-mini

## Tests

`lib/components/ask/__tests__/ask-affordance.test.ts` — 20 vitest tests
covering `SURFACE_SOURCE_TYPE` mapping (7), `buildConfig()` (10), and
`AskContext rendering helpers` (3). All pass.

## No vaporware confirmation

The route calls `chatGrounded()` from `data-agent-client.ts` directly — same
AOAI pipeline used by the existing data-agent chat route. No mock arrays, no
`return []` stubs. The `NoAoaiDeploymentError` gate is an honest infra gate
(names the exact env var `LOOM_AOAI_ENDPOINT`), not a Fabric requirement.

## Browser E2E owed (G1)

Full in-browser E2E receipt required before "A grade". The click path to verify:
1. Open a lakehouse item with delta table → click "Ask" button in preview grid
2. Type a question about the data → confirm grounded answer with real rows
3. Open a KQL dashboard with tiles → confirm "Ask" renders and returns ADX results
4. Open a report → switch to "Ask" tab → confirm answer references report tables
5. Open a semantic model → switch to "Ask" tab → confirm answer
6. Open an OSDK editor with a bound ontology → confirm "Ask" appears and answers

PR author owes this receipt. `tsc` + `vitest` + this parity doc = B grade until
browser E2E is attached.
