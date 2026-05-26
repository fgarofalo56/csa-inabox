# Loom Prompt Flow Editor — AI Foundry parity spec

> Captured 2026-05-26 by catalog agent `fabric-parity-loop`. Sources: Microsoft Learn — [Prompt flow in Microsoft Foundry portal](https://learn.microsoft.com/azure/foundry-classic/concepts/prompt-flow), [Get started with prompt flow](https://learn.microsoft.com/azure/machine-learning/prompt-flow/get-started-prompt-flow), [Variants in prompt flow](https://learn.microsoft.com/azure/machine-learning/prompt-flow/concept-variants), [Tune prompts using variants](https://learn.microsoft.com/azure/machine-learning/prompt-flow/how-to-tune-prompts-using-variants). Cross-checked against `apps/fiab-console/lib/editors/foundry-sub-editors.tsx::PromptFlowEditor` (lines 207–280) and BFF routes under `apps/fiab-console/app/api/items/prompt-flow/`.

> **Retirement note:** Prompt Flow feature development ended 2026-04-20 and the surface enters read-only mode on 2027-04-20. Microsoft recommends migrating to the **Microsoft Agent Framework**. Loom should ship parity to grade B and tag the editor `Badge="Maintenance"`, with a follow-on `agent-framework-flow` editor to take over before the EOL window.

## What it is

A **Prompt Flow** is an AI Foundry / Azure ML workspace item that encodes an executable LLM workflow as a **Directed Acyclic Graph (DAG)** of typed nodes. Each node is a tool with a strict input/output contract; edges encode data dependencies. The editor lets prompt engineers:

- Compose flows visually (graph) or edit the underlying `flow.dag.yaml` directly (raw / flatten view)
- Run a single row of inputs interactively and inspect each node's outputs
- Create multiple **variants** of an LLM node (different prompts and connection settings) and A/B them
- Submit a **batch run** over a dataset and pair it with an evaluation flow
- Deploy a flow as a managed online endpoint
- Trace runs in the observability / monitoring surface

There are three first-class flow types: **standard**, **chat** (with chat-input / chat-history / chat-output conventions), and **evaluation** (consumes the outputs of another flow run as inputs).

## UI components

### Page chrome
- Title bar shows flow name, flow type badge, saved-state indicator
- Right-side actions: **Run**, **Evaluate**, **Deploy**, **Share**, **Save**, **Save as**

### Top toolbar
| Button | Behavior |
|---|---|
| **Run** | Executes the flow against the input row currently bound in the Inputs section; when an LLM node has variants, opens a picker to select which variant to use |
| **Evaluate** | Opens the **Batch run & Evaluate** wizard (select node→variants→dataset→evaluation flow→runtime) |
| **Deploy** | Wizard for publishing the flow as a managed online endpoint (endpoint name, deployment, instance type/count, auth, environment, traffic split) |
| **Compute session / Runtime** ▼ | Picks the runtime (automatic runtime or a serverless compute session) the flow executes on |
| **View** ▼ | Switches between **Flow** (vertical card stack), **Flatten**, and **Raw file mode** (text editor over `flow.dag.yaml`) |

### Flow / Flatten view (default left pane)
- **Inputs** card at top: typed input schema (`name`, `type` ∈ `string` / `int` / `bool` / `list` / `object`, default value, sample value)
- **Outputs** card at bottom: typed output schema with reference expressions (e.g. `${classify_with_llm.output.category}`)
- Between them, one card per node:
  - **LLM node**: connection picker, deployment, model params (temperature, top_p, max_tokens, stop, presence/frequency penalty), system + user prompt with Jinja2 templating, inputs section (each Jinja variable maps to an upstream reference), **variants tab** strip
  - **Python node**: inline Python editor (`def python_tool(...): -> str`), `requirements.txt` reference, inputs section
  - **Prompt node**: pure Jinja2 prompt template (no LLM call) used as a string output to feed downstream nodes
  - **Tool node**: built-in tools (Embedding, Vector DB Lookup, Faiss Index Lookup, Azure AI Content Safety, Serp API, OpenAI GPT-Vision, Azure OpenAI GPT-4V, Azure AI Search) — each surfaces a parameter form
  - Per-node actions: **Run this node**, **More** (duplicate, delete, clone as variant, set as default variant, view raw)

### Graph view (right pane, default lower-right)
- DAG canvas rendered from `flow.dag.yaml` — nodes are rectangular cards labeled with name + type, edges are inferred from `${node.output.field}` references
- Zoom in / out / fit, **Auto layout** button, click a node to highlight it in the Flow view

### Files browser (top-right)
- Tree of the flow folder: `flow.dag.yaml`, source files (`.py`, `.jinja2`), `requirements.txt`, sample data, generated logs
- **Upload** / **Download** / **New file**
- Clicking a file opens it in a tab when **Raw file mode** is on

### Variants surface (per LLM node)
- Tabs **Variant 0** … **Variant N** above the LLM node's prompt area
- **+ Clone as variant** creates a copy with editable prompt + connection settings
- Default variant indicator (star icon) — the variant used in single-row runs and the one persisted as canonical
- **Run all variants** button at the top toolbar of the node (only available when ≥2 variants exist)
- Variant comparison strip: after a run, each variant chip shows tokens / latency / output snippet

### Batch run & Evaluate wizard
- Step 1 — **Select node to vary** (must be an LLM node with ≥2 variants)
- Step 2 — **Batch run settings**: run name, runtime, data source (uploaded file, registered dataset, blob path); column mapping from dataset columns to flow inputs
- Step 3 — **Evaluation settings**: pick an evaluation flow (built-in: Classification Accuracy Evaluation, QnA Groundedness, QnA Relevance, QnA Coherence, QnA Fluency, QnA Similarity, F1 Score; or custom), map eval inputs to flow outputs + ground truth columns
- Step 4 — **Review + submit**
- After submit: link to **Run detail** page; multi-select runs in the run list → **Visualize outputs** shows per-row predictions and aggregated metric bars for each variant

### Deploy wizard
- Endpoint type (managed online), endpoint name, deployment name, instance type (e.g. `Standard_DS3_v2`), instance count, auth (key / AAD token), environment (Curated for prompt flow), output (request / response logging on/off + sampling), tags, traffic split when adding to an existing endpoint

### Monitor integration
- After deploy, the endpoint surfaces in the Foundry **Observability** hub with token usage, latency, success rate, sampled drift / groundedness metrics

## What Loom has

Current `PromptFlowEditor` (`apps/fiab-console/lib/editors/foundry-sub-editors.tsx` lines 207–280) is real-REST wired to the AML data plane via `lib/azure/foundry-client.ts::listPromptFlows / getPromptFlow / createPromptFlow / deletePromptFlow / submitFlowRun` and the BFF routes `GET|POST /api/items/prompt-flow`, `GET|DELETE /api/items/prompt-flow/[id]`, `POST /api/items/prompt-flow/[id]/run`.

- Project picker → lists flows under `{project}/PromptFlows?pageSize=50`
- Table columns: **Name**, **Type**, **Modified**, action **Open**
- Selected flow opens a card with:
  - A `<textarea>` showing `JSON.stringify(flow.flowDefinition || flow, null, 2)` — the raw DAG, read-only-edit-only (no save back yet)
  - A `<textarea>` for **Run inputs** (JSON)
  - **Run flow** button → POSTs to `/run` and shows result JSON in a `<pre>` block
- Errors surface honestly via `ErrorBar` + `NotDeployedError` (503 + `notDeployed:true`)

That is: Loom can list, read, run, and delete prompt flows, but it has no graph view, no variants, no batch run, no evaluation wizard, no deploy action, no node-level UI, and no `flow.dag.yaml` round-trip save.

## Gaps for parity

1. **Graph (DAG) view** — no visual canvas; Loom shows raw JSON only. Needs a flow renderer (Reactflow or dagre) reading nodes + inferring edges from `${node.output.*}` references.
2. **Per-node cards (Flow / Flatten view)** — no typed editor for LLM, Python, Prompt, or Tool nodes. Each node type needs a dedicated form (connection / deployment / model params for LLM; inline editor + requirements for Python; Jinja editor for Prompt; tool-specific form).
3. **Inputs / Outputs typed schema** — Loom dumps the whole definition into a textarea. Inputs/Outputs need their own grids with type pickers and sample values.
4. **Variants UI** — no tab strip, no "Clone as variant", no "Run all variants", no per-variant metric chips. Variants are the headline differentiator of prompt flow; this is the largest gap.
5. **Save back** — `createPromptFlow` exists in the client but the editor has no Save button wiring; the textarea edits are dropped.
6. **Run a single node** — Foundry lets you run one node in isolation; Loom only supports `submitFlowRun` against the whole flow.
7. **Batch run & Evaluate wizard** — not present. Today you'd switch to the Evaluation editor, which is a separate UI flow and doesn't accept a `selectVariantNode` parameter.
8. **Deploy** — no UI; no `deployFlowAsEndpoint` helper in the foundry client.
9. **Files browser** — no tree view of `flow.dag.yaml` + sources; no upload / download of `requirements.txt` or `.py` files.
10. **Compute session picker** — Loom doesn't expose the runtime / compute session selection; runs go against whatever the workspace default is.
11. **Tool catalog** — no picker for built-in tools (Embedding, Vector DB Lookup, Content Safety, etc.); user has to hand-author tool nodes in raw YAML.
12. **Chat-flow conventions** — no special handling for `chat_input` / `chat_history` / `chat_output` types when the flow is a Chat flow.

## Backend mapping

The AML data-plane endpoints live at `{regional-aml-endpoint}/flow/api/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.MachineLearningServices/workspaces/{ws}/PromptFlows` (already wrapped by `projectDataPlaneSegment` in `foundry-client.ts`).

| Loom surface | Backend call (AML data plane) |
|---|---|
| List flows | `GET .../PromptFlows?pageSize=50` (already wired via `listPromptFlows`) |
| Get flow | `GET .../PromptFlows/{flowId}` (already wired via `getPromptFlow`) |
| Create / save flow | `POST .../PromptFlows` with `{ flowName, flowType, flowDefinition, description }` (helper exists, UI unwired) |
| Delete flow | `DELETE .../PromptFlows/{flowId}` (already wired) |
| Single-row run | `POST .../PromptFlows/{flowId}/submit` with `{ inputs, variants?: { nodeName, variantId } }` (already wired for the no-variant case) |
| Single-node run | `POST .../PromptFlows/{flowId}/submit` with `{ inputs, nodeName }` (variation of submit) |
| Batch run | `POST .../FlowRuns` with `{ flowId, dataPath, runtimeName, variantId?, evaluationFlowId? }` |
| Get run / status | `GET .../FlowRuns/{runId}` and `GET .../FlowRuns/{runId}/logContent` |
| Visualize outputs | `GET .../FlowRuns/{runId}/childRuns` + per-row metric aggregations |
| Deploy as endpoint | `POST .../onlineEndpoints/{ep}/deployments/{name}` ARM call (template references the flow's image + scoring script) |
| List built-in tools | `GET .../Tools` |

New helpers required in `foundry-client.ts`: `submitBatchFlowRun`, `getFlowRun`, `getFlowRunChildRuns`, `listFlowTools`, `deployFlowEndpoint`, `saveFlowDefinition` (POST wrapper for re-saving an edited flow with variant set).

## Required Azure resources

- **AI Foundry hub workspace** (`Microsoft.MachineLearningServices/workspaces` kind=`Hub`) — already provisioned as `aifoundry-csa-loom-eastus2`; data-plane reachable from the Loom MI
- **AI Foundry project** (`workspaces/projects/{name}`) — UI requires a project picker; UAMI needs **AzureML Data Scientist** on the project
- **Compute session / serverless runtime** — for `Run` to succeed; the workspace's default automatic runtime is sufficient
- **Connections** in the project: at minimum one Azure OpenAI connection (for LLM nodes); optional Content Safety, AI Search, Cognitive Search for tool nodes
- **Storage** — the workspace's attached storage account for flow source files and batch-run outputs
- **Application Insights** — for trace visibility post-deploy

`MessageBar intent="warning"` when any of: project not picked, `LOOM_FOUNDRY_NAME` unset, project has no AOAI connection, no automatic runtime configured.

## Estimated effort

**3 sessions** to reach grade B:

- **Session N+1 (~2.5 hrs):** Replace JSON textarea with Inputs/Outputs grids + per-node cards (LLM / Python / Prompt). Wire **Save** button to `createPromptFlow` POST. Add **Run this node** support.
- **Session N+2 (~3 hrs):** Variants tab strip on LLM nodes (Clone as variant, set default, run all variants, per-variant chips). Build Reactflow DAG view with auto-layout from `${node.output.*}` reference parsing.
- **Session N+3 (~2 hrs):** Batch run & Evaluate wizard (4 steps), pairing to the Evaluation editor via `submitBatchFlowRun`. Deploy wizard skeleton calling `deployFlowEndpoint`. Files browser surfacing `flow.dag.yaml` + `requirements.txt`.

Grade A+ adds Vitest coverage on the `${...}` reference parser, Playwright e2e against a seeded standard flow with two variants, and bicep additions documenting the AOAI connection + automatic runtime baseline on the hub.
