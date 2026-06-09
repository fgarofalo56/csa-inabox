# notebook-fix-with-copilot — parity with Fabric Notebook "Fix with Copilot" (failed-cell error remediation)

Source UI: Fabric notebook cell-error Copilot — https://learn.microsoft.com/fabric/data-engineering/copilot-notebooks-overview (the "Fix error" affordance that surfaces under a failed cell / Spark job output)

Surface: the inline banner + approve-diff dialog that auto-surfaces **under a failed cell output** (distinct from the in-cell Copilot popover documented in `notebook-in-cell-copilot.md`).

Components:
- Banner trigger: `apps/fiab-console/lib/components/notebook/code-cell.tsx` (renders the `Sparkle16Regular` "Fix with Copilot" button when `cell.output.status === 'error' && !locked`)
- Dialog: `apps/fiab-console/lib/components/notebook/copilot-pane.tsx`
- Prompt/parse helpers: `apps/fiab-console/lib/copilot/notebook-tools.ts`
- Backend: `apps/fiab-console/app/api/copilot/sessions/route.ts` (`mode:'cell-fix'`, real AOAI chat-completions — no Fabric Copilot dependency)
- Error source: `apps/fiab-console/lib/azure/synapse-livy-client.ts` `normalizeLivyOutput` (real Livy `ename/evalue/traceback` — no synthetic strings)

## Fabric feature inventory

| # | Capability | Where in Fabric |
|---|---|---|
| 1 | "Fix" affordance appears automatically beneath a cell / Spark job that errored | Under the cell output |
| 2 | Uses the cell code + the real runtime error to diagnose | Copilot context |
| 3 | Shows an error **summary** of what went wrong | Fix card |
| 4 | Shows the **root cause** | Fix card |
| 5 | Proposes a corrected version of the cell (a fix) | Fix card |
| 6 | User can review the fix as a diff against the current cell before applying | Fix card |
| 7 | "Keep" / apply replaces the cell with the proposed code | Fix card → canvas |
| 8 | After applying, the cell can be re-run and succeeds | Canvas |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Banner button auto-renders under any error output via `cell.output.status === 'error' && !locked` (code-cell.tsx) — no manual trigger, no synthetic error |
| 2 | ✅ | POST sends `cellSource` + `errorContext {ename,evalue,traceback}` (verbatim from `normalizeLivyOutput`) + execution details (`executionCount`, `durationMs`, `executedAtUtc`, server-side `LOOM_SYNAPSE_SPARK_POOL`) → `buildCellFixMessages` |
| 3 | ✅ | Model returns structured JSON `{summary,rootCause,proposedCode}`; `summary` rendered in a Fluent `MessageBar intent="warning"` titled "Error summary" |
| 4 | ✅ | `rootCause` rendered under a "Root cause" caption |
| 5 | ✅ | `proposedCode` rendered in the "Proposed fix" Monaco editor |
| 6 | ✅ | Dialog shows "Current (failing)" + "Proposed fix" Monaco editors side-by-side as a review diff |
| 7 | ✅ | "Keep" button → `onAccept(proposedCode)` → code-cell replaces `cell.source`, clears `output` + `executionCount` |
| 8 | ✅ | Cleared output lets the user re-run via the real Livy execute path; a corrected cell succeeds |

Honest gate: when AOAI is not configured the route returns `503 {code:'no_aoai', hint}`; the dialog surfaces it in a Fluent `MessageBar intent="error"` naming the AI Foundry bicep module to deploy. Full UI still renders (per `no-vaporware.md`). A non-JSON model reply falls back honestly: the raw suggestion becomes the proposed code and `summary` states the response could not be parsed (never a fabricated diagnosis).

## Backend per control
- All controls → `POST /api/copilot/sessions {mode:'cell-fix'}` → AOAI chat-completions via `resolveAoaiTarget()` (same resolution chain as the cross-item Copilot / data-agent). AAD bearer minted against `LOOM_AOAI_AUDIENCE` (`.us` for Gov clouds, `.com` for commercial — wired by `admin-plane/main.bicep`). The structured `{summary,rootCause,proposedCode}` contract is built by a JSON-instruction system prompt (not `response_format:{type:'json_object'}`) so it works on Gov-deployed and reasoning models. No Fabric / Power BI host on any path; works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Each fix is persisted (best-effort) to the `copilot-sessions` Cosmos container with `summary`/`rootCause` for audit history.

## Bicep / bootstrap
No new infra. Reuses `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_AUDIENCE` (and optional `LOOM_SYNAPSE_SPARK_POOL`) already emitted by `platform/fiab/bicep/modules/admin-plane/main.bicep` when `agentFoundryEnabled=true`. The `copilot-sessions` Cosmos container already exists.

Grade: **A (all inventory rows built + real AOAI backend over real Livy errors; unit-tested via `notebook-tools.test.ts` (16) + `cell-fix-route.test.ts` (10)).**
