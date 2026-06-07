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
| 4 | Slash command `/fix` — corrected code from the cell's error | Prompt box |
| 5 | Free-form / `/generate` prompt — new runnable code from a description | Prompt box |
| 6 | Result inserted as a NEW cell below (markdown for explain, code otherwise) | Canvas |
| 7 | Submit via Enter or a Run/Send button | Prompt box |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Fluent `Sparkle16Regular` "Copilot" button added to the `CodeCell` toolbar (`copilotEnabled = !!notebookId && !!onInsertBelow`); hidden in the legacy scratchpad pane that has no notebook id |
| 2 | ✅ | Fluent `Popover` (`positioning="below-start"`, `trapFocus`) anchored to the toolbar button — floats over the cell, does not displace layout |
| 3 | ✅ | `/explain` → `POST /api/notebook/{id}/assist {mode:'explain'}`; result inserted as a **markdown** cell prefixed `## Copilot explanation` |
| 4 | ✅ | `/fix` → `{mode:'fix'}` with the cell's `output.ename/evalue/traceback` as `errorText`; disabled unless the cell has an error output, with an honest inline error if not run yet |
| 5 | ✅ | `/generate <text>` and free-form text → `{mode:'generate', prompt}`; result inserted as a **code** cell in the source cell's language |
| 6 | ✅ | `onInsertBelow` splices the new cell directly below by stable `cell.id` (not a stale index) and focuses it; notebook marked dirty |
| 7 | ✅ | Enter key and a primary **Run** button both submit; busy spinner + disabled state while in flight |

Honest gate: when AOAI is not configured the assist route returns `503 {code:'no_aoai', hint}`; the popover surfaces it in a Fluent `MessageBar intent="warning"` naming the AI Foundry bicep module to deploy. Full UI still renders (per `no-vaporware.md`).

## Backend per control
- All modes → `POST /api/notebook/[id]/assist` → AOAI chat-completions via `resolveAoaiTarget()` (same resolution chain as the cross-item Copilot / data-agent). AAD bearer minted against `LOOM_AOAI_AUDIENCE` (`.us` for Gov clouds, `.com` for commercial — wired by `admin-plane/main.bicep`). No Fabric / Power BI host on any path; works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Bicep / bootstrap
No new infra. Reuses `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_AUDIENCE` already emitted by `platform/fiab/bicep/modules/admin-plane/main.bicep` when `agentFoundryEnabled=true`.

Grade: **A (all inventory rows built + real AOAI backend; unit-tested via `copilot-commands.test.ts` + `code-cell-copilot.test.tsx`).**
