# code-interpreter — parity with Databricks AI / Jupyter Code Interpreter + Azure AI Foundry Notebooks
Source UI: Databricks AI/BI Genie code-interpreter tab · Azure AI Foundry Notebooks · OpenAI ChatGPT code-interpreter

## Scope
WS-5.3: conversational code-interpreter turn in the data-agent chat panel.
Surface: `lib/panes/data-agent.tsx` → `CodeInterpreterBlock` component.
Backend: `POST /api/copilot/code-interpret` → real Synapse Livy pyspark statement.
Logic: `lib/copilot/code-interpreter.ts` (pure, tested).

## Source feature inventory (Databricks AI/BI Genie + Azure Notebooks code-interpreter)

| # | Feature | Reference |
|---|---------|-----------|
| 1 | Model proposes Python code inline in chat | Genie / ChatGPT code-interpreter |
| 2 | User clicks "Run" to execute in sandbox | Genie / ChatGPT |
| 3 | Execution is isolated / ephemeral per turn | ChatGPT code-interpreter |
| 4 | stdout + error traceback returned inline | Genie / ChatGPT |
| 5 | Generated charts (matplotlib) shown inline as images | ChatGPT / Databricks Notebook |
| 6 | Execution audited (who ran what, when, elapsed) | Azure AI Foundry audit log |
| 7 | Timeout enforcement (runaway code doesn't spin) | ChatGPT |
| 8 | Output size cap (no accidental GB stdout) | ChatGPT |
| 9 | Re-run button | ChatGPT |
| 10 | Status bar with runtime type + elapsed time | Databricks Notebook |
| 11 | Honest gate when backend not configured | Loom convention |
| 12 | Keyboard accessible (tabIndex on code/output pres) | WCAG 2.1 |

## Loom coverage

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Model proposes Python code inline | ✅ | `extractPythonProposals()` detects ````python` blocks in AOAI answer |
| 2 | "Run in sandbox" button | ✅ | `CodeInterpreterBlock` → `runCodeInterp()` → `POST /api/copilot/code-interpret` |
| 3 | Ephemeral / warm-pool session | ✅ | `acquireWarmSession` (warm pool) or ephemeral `createLivySession` + `killLivySession` |
| 4 | stdout + error traceback | ✅ | `normalizeLivyOutput` → `parseInterpreterOutput` → rendered in `<pre>` |
| 5 | Charts inline | ✅ | `image/png` passthrough via Livy `NormalizedOutput.imageBase64` → `<img data:image/png…>` |
| 6 | Audit | ✅ | `emitAuditEvent({ action: 'copilot.code-interpret.run' })` fire-and-forget |
| 7 | Timeout | ✅ | 60 s poll loop (BFF) + `threading.Timer` watchdog in Python wrapper |
| 8 | Output size cap | ✅ | 64 KB stdout, 5 MB/chart, 3 charts max |
| 9 | Re-run | ✅ | "Re-run" button on completed turns |
| 10 | Status bar | ✅ | pyspark · elapsed label |
| 11 | Honest gate | ✅ | `gate:true` → Fluent `MessageBar` with exact missing env-var + "Fix it in Admin" CTA |
| 12 | Keyboard accessible | ✅ | `tabIndex={0}` on `<pre>` elements, button aria-labels |

## Backend per control

| Control | Route | Azure client | Notes |
|---------|-------|-------------|-------|
| "Run in sandbox" | `POST /api/copilot/code-interpret` | `synapse-livy-client` (Livy sessions/statements REST) | Warm pool via `spark-session-pool.ts`; fallback ephemeral |
| Audit | same route (fire-and-forget) | `audit-stream.ts` → Azure Monitor DCR | LoomAudit_CL |
| "Fix it in Admin" | `GET /admin?tab=health` | n/a | Client-side navigation |

## No new bicep modules
The code-interpreter reuses the existing Synapse Spark pool and warm-session pool infrastructure.
No new Azure resources, no new Cosmos containers, no new env vars (reuses `LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_SPARK_POOL`).

## G1 browser-E2E receipt (owed — Track-0)
Browser E2E with a running Synapse workspace is owed before A-grade sign-off.
Acceptance: "analyze this table" → model returns ````python` block → "Run in sandbox" → Spinner → stdout + chart inline → status bar shows elapsed. Audited in LoomAudit_CL.
