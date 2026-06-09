# notebook-in-cell-copilot — parity with Fabric Notebook in-cell Copilot

Source UI: Fabric in-cell Copilot — https://learn.microsoft.com/fabric/data-engineering/copilot-notebooks-chat-pane#in-cell-copilot
Component: `apps/fiab-console/lib/components/notebook/code-cell.tsx`
Helpers: `apps/fiab-console/lib/components/notebook/copilot-commands.ts`
Backend: `apps/fiab-console/app/api/notebook/[id]/assist/route.ts` (real AOAI chat-completions, no Fabric Copilot dependency)

## Fabric feature inventory

| # | Capability | Where in Fabric |
|---|---|---|
| 1 | Copilot button in the cell toolbar (above each code cell) | Cell toolbar |
| 2 | Click opens an inline prompt text box (not the full sidebar) | Popover over the cell |
| 3 | Slash command `/explain` — plain-language explanation of the cell | Prompt box |
| 4 | Slash command `/fix` — corrected code from the cell's real run error | Prompt box |
| 5 | Slash command `/comments` — add inline comments/docstrings to the cell | Prompt box |
| 6 | Slash command `/optimize` — rewrite the cell for Spark performance | Prompt box |
| 7 | Free-form / `/generate` prompt — new code, or a refactor of the cell | Prompt box |
| 8 | Code-modifying results reviewed (diff) and accepted before they apply | Inline diff |
| 9 | Explanations / new code inserted as a NEW cell below | Canvas |
| 10 | Submit via Enter or a Run/Send button | Prompt box |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Fluent `Sparkle16Regular` "Copilot" button on the `CodeCell` toolbar (`copilotEnabled = !!notebookId && !!onInsertBelow`); hidden in the legacy scratchpad pane |
| 2 | ✅ | Fluent `Popover` (`positioning="below-start"`, `trapFocus`) over the cell — floats, does not displace layout |
| 3 | ✅ | `/explain` → `{mode:'explain'}`; `inCellResultAction='insert-below'` → markdown cell `## Copilot explanation` |
| 4 | ✅ | `/fix` → `{mode:'fix'}`; client sends the cell's cached `output.ename/evalue/traceback`; the route falls back to the **live** Livy error (`getLastLivyError(pool,id)` from `state.sparkSession`) when the cache is empty; approval-diff |
| 5 | ✅ | `/comments` → `{mode:'comments'}`; re-commented code; `propose-edit` → approval-diff |
| 6 | ✅ | `/optimize` → `{mode:'optimize'}`; perf-rewrite (broadcast / push-down / no UDFs); approval-diff |
| 7 | ✅ | `/generate <text>` / free-form → `{mode:'generate'}`; refactor verbs ("convert/refactor/extract/…") route to approval-diff, a new-cell ask inserts below |
| 8 | ✅ | `proposedCode` panel inside the popover with **Accept** (replaces `cell.source`, clears stale `output`/`executionCount`) / **Reject**; only code-modifying modes use it |
| 9 | ✅ | `onInsertBelow` splices below by stable `cell.id` and focuses it; notebook marked dirty |
| 10 | ✅ | Enter and a primary **Run** button submit; busy spinner + disabled state in flight |

Honest gate: when AOAI is not configured the assist route returns `503 {code:'no_aoai', hint}`; the popover surfaces it in a Fluent `MessageBar intent="warning"` naming the AI Foundry bicep module to deploy. Full UI still renders (per `no-vaporware.md`).

## Backend per control
- All modes → `POST /api/notebook/[id]/assist` → AOAI chat-completions via `resolveAoaiTarget()` (same chain as the cross-item Copilot / data-agent). Prompts built by the shared `lib/copilot/notebook-tools.buildAssistMessages` (one canonical source for the popover and the route). AAD bearer minted against `LOOM_AOAI_AUDIENCE` (`.us` Gov / `.com` commercial). No Fabric / Power BI host on any path; works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- `/fix` live error → `getLastLivyError(pool, sessionId)` → `GET {devBase}/livyApi/.../sessions/{id}/statements` on the live Synapse Spark session for that notebook. `devBase()` now honours `LOOM_SYNAPSE_DEV_SUFFIX` so the call is GCC-High / IL5 (`azuresynapse.us`) correct.

## Bicep / bootstrap
No new infra. Reuses `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_AUDIENCE` already emitted by `admin-plane/main.bicep` when `agentFoundryEnabled=true`. `platform/fiab/bicep/modules/ai/foundry-project.bicep` documents that its `chat` deployment also backs this in-cell surface; the three existing role assignments on the Foundry account cover the AOAI scope.

Grade: **A (all inventory rows built + real AOAI backend + live-Livy `/fix`; unit-tested via `notebook-tools.test.ts` + `copilot-commands.test.ts` + `synapse-livy-client.test.ts` + `code-cell-copilot.test.tsx`).**
