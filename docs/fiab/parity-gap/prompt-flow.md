# prompt-flow — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/prompt-flow/new`
**Fabric reference**: ai.azure.com — Prompt Flow visual DAG authoring (nodes + connectors + Run + Bulk test + Evaluate)
**Loom screenshot**: `temp/parity/prompt-flow-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/prompt-flow?project=loom-project-default` | **403** | Foundry data-plane (`*.workspace.eastus2.api.azureml.ms`) rejects our token — auth/role issue, not a code problem |
| `POST /api/items/prompt-flow/<id>/run` | wired but blocked by 403 | — |

The editor renders a Project picker dropdown. Once a project is picked, the BFF tries to list flows from the Foundry workspace MLClient — the workspace returns 403 (nginx response) because our UAMI does not have the right `Microsoft.MachineLearningServices/workspaces/promptflows/read` role on the project workspace. Editor shows "Pick a project to list its prompt flows." with no flows visible.

## Phase 3 — Fabric vs Loom

| Fabric element | Loom present? | Severity |
|---|---|---|
| **Visual DAG editor** (nodes for LLM/Python/Tool, connectors with arrows, drag-to-connect) | **NO — Loom has a `<textarea>` for raw JSON** | **BLOCKER** |
| **Node inspector panel** (prompts/temperature/model selection per node) | NO | BLOCKER |
| **Live execution graph** (highlight current running node + per-node timing) | NO | BLOCKER |
| Input/output schema panel | NO | MAJOR |
| Run / Bulk test / Evaluate ribbon | partial — single "Run flow" button after a flow is selected | MAJOR |
| Run history grid (per-row inputs/outputs, latency, cost, eval scores) | NO | BLOCKER |
| Compute attach dropdown | NO | MAJOR |
| Connections binding pane | NO | MAJOR |
| Sample inputs library | NO | MINOR |
| **Monaco JSON editor with schema validation** | NO — plain `<textarea>` | MAJOR (BLOCKER per build-phase contract section 1) |

## Functional

- Project picker dropdown — wires to real BFF
- Flow list is empty because backend 403s
- Run button cannot be exercised (no flows to select)

## Grade — **F**

Three observations push this to F:
1. **403 on the actual list call** — the editor can never display real flows in this deployment, and there's no honest MessageBar telling the operator "your UAMI is missing the AzureML Data Scientist role on this project"; instead the editor just shows an empty state with "Pick a project to list its prompt flows" even after a project IS picked.
2. **Plain textarea instead of visual DAG** — the entire reason for a Prompt Flow editor is the graph-based authoring; without it this is JSON config typing.
3. **No Monaco** — violates the build-phase mandatory standard #1 (Monaco + IntelliSense for code/query/text editors).

This is vaporware-adjacent: the editor looks like it should let you author flows but the data-plane is unreachable AND the UI is the wrong shape. Per `no-vaporware.md` rule, the gate should surface an honest MessageBar explaining the role gap. **Grade F.**
