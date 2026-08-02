# prompt-flow — parity with Azure AI Foundry / Azure ML prompt flow (authoring designer)

Source UI: Azure AI Foundry portal → Prompt flow → flow authoring designer
(https://learn.microsoft.com/azure/machine-learning/prompt-flow/how-to-develop-flow,
https://learn.microsoft.com/azure/machine-learning/prompt-flow/concept-flows).
Backend: the Foundry project's AML data-plane (`{region}.api.azureml.ms/flow/api/.../PromptFlows`)
via the Loom Console UAMI (`https://management.azure.com/.default`), plus the hub
connections list (`Microsoft.MachineLearningServices/workspaces/{hub}/connections`).

## What this replaces

The old `PromptFlowEditor` was a single Monaco JSON textarea over the raw
`flowDefinition` plus a JSON "run inputs" box. Per `ui-parity.md` that is
explicitly forbidden ("Replacing a rich Azure/Fabric surface (canvas, designer,
…) with a … JSON textarea"). The operator verdict: *"The LangChain-style flow
graph … is nothing like what it should look like. Not usable, doesn't work. It
should be a visual builder that shows the JSON inputs/outputs … work like the
regular builder."*

This rebuild is a real visual flow-DAG designer that round-trips to
`flow.dag.yaml` and runs against the real prompt-flow REST.

## Azure / Foundry feature inventory → Loom coverage

| Foundry prompt-flow designer capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| List flows in a project | ✅ built — Flow dropdown from `listPromptFlows(project)` | `GET …/PromptFlows?pageSize=50` |
| Open a flow into the designer | ✅ built — loads `flowDefinition` → `FlowDag` (yaml or object) | `GET …/PromptFlows/{id}` |
| Create a flow (Standard) | ✅ built — name + "Create flow" (starter template) | `POST …/PromptFlows` `{flowName, flowType, flowDefinition}` |
| **Graph view** (DAG of Inputs → nodes → Outputs) | ✅ built — `PromptFlowBuilder` canvas; edges derived from `${node.output}` / `${inputs.x}` refs, same as Foundry's Graph view; auto rank/column layout + SVG arrows | derived client-side from the flow def |
| Flow **Inputs** panel (name/type/default) | ✅ built — Inputs tab (add/edit/remove, typed) + live JSON view | round-trips in `flow.dag.yaml` `inputs:` |
| Flow **Outputs** panel (name/type/reference) | ✅ built — Outputs tab (add/edit/remove, `${node.output}` reference) + live JSON view | round-trips in `outputs:` |
| Add tool node: **LLM** | ✅ built — palette "LLM"; node config = Connection + API (chat/completion) + Deployment + Jinja2 prompt template + parameters (temperature/max_tokens) | `connection`/`api`/`deployment_name`/`provider`/`module` in node |
| Add tool node: **Prompt** | ✅ built — palette "Prompt"; Jinja2 template editor | `type: prompt` node |
| Add tool node: **Python** | ✅ built — palette "Python"; Python code editor (boilerplate `@tool`) | `type: python` node |
| Node inputs (literal **or** `${...}` reference) | ✅ built — per-node inputs key/value grid with reference helper text | node `inputs:` map |
| Wire nodes by reference (`${node.output}` / `${inputs.x}`) | ✅ built — typing a reference adds the edge on the canvas automatically; rename rewrites references | derived |
| Rename a node | ✅ built — renames + rewrites `${old.output}` refs across nodes + outputs | client model |
| Delete a node | ✅ built — node config "delete" | client model |
| Raw `flow.dag.yaml` view / edit | ✅ built — YAML tab (Monaco yaml), "Apply to graph" reparses & round-trips | `serializeFlowDag`/`parseFlowDag` |
| **Save** the flow | ✅ built — "Save flow" PUTs serialized `flow.dag.yaml` | `PUT …/PromptFlows/{id}` `{flowDefinition}` |
| **Run** (single-input test run) | ✅ built — "Run" submits the saved flow with the inputs' defaults; shows per-node outputs + final output | `POST …/PromptFlows/{id}/submit` `{inputs}` |
| LLM connection set-up gate | ⚠️ honest-gate — when the hub has no AOAI/AI-Services connection, a Fluent `MessageBar intent="warning"` names the action (Foundry Management center → Connections) + the bicep module `platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep`; the full designer still renders, Run is disabled until a connection exists | `GET /api/foundry/connections` |
| Compute-session gate on Run | ⚠️ honest-gate — a run with no started compute session returns the backend error / `NotDeployedError` surfaced in a MessageBar (start the session in Foundry) | `submitFlowRun` error path |
| Refresh the connection list (Foundry portal "Refresh" on Connections) | ✅ built (#2584) — a "Refresh connections" button on the picker toolbar, and the ribbon **Reload**, both re-read the route with `?refresh=1` so a connection created outside Loom appears immediately instead of waiting out the 5-min server memo (#2557) | `GET /api/foundry/connections?refresh=1` |
| Partial / truncated connection list | ⚠️ honest-gate — when the ARM walk hits its pages/time ceiling the route returns `truncated`; the editor shows a "Connection list is partial" MessageBar naming the knob (`LOOM_ARM_PAGING_MAX_PAGES` / `LOOM_ARM_PAGING_BUDGET_MS`) and SUPPRESSES the "no LLM connection" gate — a paging deadline is never reported as an empty hub | `truncated` on `GET /api/foundry/connections` |

Zero ❌. Zero stub banners. The only non-functional states are the two honest
infra gates above, and even then the full canvas + I/O panels render.

## Backend per control

- List / create: `/api/items/prompt-flow` (GET `listPromptFlows`, POST `createPromptFlow`).
- Open / save / delete: `/api/items/prompt-flow/[id]` (GET `getPromptFlow`, PUT `updatePromptFlow`, DELETE `deletePromptFlow`).
- Run: `/api/items/prompt-flow/[id]/run` → `submitFlowRun(project, id, inputs)` (`POST …/PromptFlows/{id}/submit`).
- LLM connections: `/api/foundry/connections` → `listConnections()` (hub `connections` ARM list), filtered to LLM-capable categories (AzureOpenAI / OpenAI / AIServices / Serverless / CustomKeys). Memoized server-side for 5 min; `?refresh=1` (Refresh connections / ribbon Reload) forces a re-read, and `truncated` reports a paging deadline.

All routes validate the session (401 unauthenticated) and require `project`
(400). `NotDeployedError` → `503 {notDeployed:true, hint}`; other Foundry
errors → the FoundryError status with the endpoint hint.

## flow.dag.yaml model

`lib/prompt-flow/flow-dag.ts` is the single source of truth: `FlowDag`
(inputs/outputs/nodes), `parseFlowDag` / `serializeFlowDag` (a deterministic
YAML (de)serializer scoped to the flow.dag.yaml shape — there is no YAML dep in
the app), and `flowToGraph` (derives Inputs/Outputs nodes + edges from `${...}`
references). The builder is a controlled component over this model; the editor
owns persistence + run.

## Tests

- `lib/prompt-flow/__tests__/flow-dag.test.ts` (12) — parse, serialize, YAML
  round-trip (incl. literal block-scalar code bodies), reference extraction,
  graph derivation.
- `lib/azure/__tests__/foundry-prompt-flow.test.ts` (9) — client list/get/
  create/save/run exact data-plane URL + method + payload + gating.
- `app/api/items/__tests__/prompt-flow-routes.test.ts` (10) — BFF route
  session/param gates, payload forwarding, 503 NotDeployed surface.

DOM render tests are pre-existing-red under the repo's global `node`
vitest-environment (`document is not defined`); coverage is via the backend
contract tests above per `no-vaporware.md`. **Update (#2584):** the jsdom
harness works for this editor now — `lib/editors/__tests__/prompt-flow.test.tsx`
(6) mounts `PromptFlowEditor` and asserts the ACTUAL connections URL requested
on mount vs on Refresh/Reload, plus the truncated-vs-empty banner split.

## Verification

`pnpm build` clean. Live side-by-side + click-every-control walk against the
real Foundry prompt-flow designer is the remaining gate (browser unavailable in
this worktree) — per `no-vaporware.md` the run probe needs a minted-session
cookie against a deployed Foundry project with a started compute session.
