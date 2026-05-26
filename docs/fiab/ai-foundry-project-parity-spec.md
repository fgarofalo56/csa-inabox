# Loom AI Foundry Project Editor — Foundry-parity spec

> Captured 2026-05-26 by catalog agent `foundry-parity-2026-05-26`. Sources: Microsoft Learn — [What is Microsoft Foundry?](https://learn.microsoft.com/azure/foundry/what-is-foundry), [New Foundry portal GA overview](https://learn.microsoft.com/azure/foundry/concepts/general-availability), [Migrate from hub-based to Foundry projects](https://learn.microsoft.com/azure/foundry-classic/how-to/migrate-project), [Foundry playgrounds](https://learn.microsoft.com/azure/foundry/concepts/concept-playgrounds), [Trace and observe AI agents](https://learn.microsoft.com/azure/foundry-classic/how-to/develop/trace-agents-sdk), [Run evaluations in the cloud](https://learn.microsoft.com/azure/foundry/how-to/develop/cloud-evaluation). Cross-checked against existing Loom editor at `apps/fiab-console/lib/editors/foundry-sub-editors.tsx::ProjectEditor` and the foundry client at `apps/fiab-console/lib/azure/foundry-client.ts::listProjects/getProject/createProject`.

## What it is

An **Azure AI Foundry project** is a workspace inside a hub where developers do their actual AI work. In the classic (hub-based) model a project is `Microsoft.MachineLearningServices/workspaces` of `kind=Project` with `properties.hubResourceId` pointing back to its parent hub; in the new Foundry-projects model it is `Microsoft.CognitiveServices/account/project`. Both flavours surface the same developer-facing capabilities through the [Foundry portal](https://ai.azure.com): browse the model catalog, deploy models, build agents, run prompt flows, run evaluations, manage datasets and indexes, view tracing, and govern threads.

A project inherits the hub's shared connections, computes, storage, and identity, then adds project-scoped connections, project-scoped data + indexes + flows + evaluations + agents, and project-scoped RBAC. It is the unit IT hands a developer team: "here is your project, build inside it."

## UI components

### Page chrome
- Title bar: project `friendlyName` + provisioning-state badge + hub-link chip (clicking returns to the hub)
- Right-side actions: **Refresh**, **Project settings**, **Open in Foundry portal**, **Delete**
- Left rail navigation (Foundry portal style): **Overview**, **Model catalog**, **Models + endpoints**, **Agents**, **Prompt flow**, **Evaluations**, **Tracing**, **Threads**, **Data + indexes**, **Datasets**, **Fine-tuning**, **Playgrounds** (Chat / Images / Audio / Video), **Project files**, **Connections**, **Compute**, **Settings** (members, properties)

### Overview tab
- Hero card: friendly name, description, endpoint URI (project endpoint for SDK), region, parent hub link
- Quick-start cards: **Create an agent**, **Deploy a model**, **Try a playground**, **Run an evaluation**, **Upload data**, **Build a flow**
- Recent activity stream: last 10 deployments / runs / agent updates

### Model catalog
- Tile grid of models filtered to those available in the project's hub region. Filters: **Collection** (Azure OpenAI, Mistral, Meta, DeepSeek, xAI, Phi, Cohere, NVIDIA, Hugging Face, custom), **Task** (chat, embedding, image-gen, video-gen, transcription, reranking), **License**, **Deployment options** (Serverless API, Managed compute, Bring-your-own)
- Tile shows: model name + version, publisher logo, short description, benchmarks badge, "Deploy" CTA
- Model details drawer: README, sample code (Python/JS/C#/Java/cURL/REST), evaluation benchmarks, license terms, model card

### Models + endpoints
- Tabs: **Deployments** (your real-time online endpoints), **Serverless API deployments**, **Batch deployments**, **Connected models** (deployments from connected AOAI resources)
- Columns: **Deployment name**, **Model**, **Version**, **Provisioning state**, **Capacity** (TPM or instances), **Traffic %**, **Created**, **Endpoint** (copy URI), **Key** (copy)
- Per-row actions: **Open in playground**, **Update capacity**, **Update traffic split**, **Delete**

### Agents
- Tile/list view of **Foundry agents** in this project: agent name, base model, instructions preview, tools count, threads count, last updated
- **+ New agent** wizard: name, model deployment, instructions, **Tools** (file_search, code_interpreter, browser, custom function, bing_grounding, fabric_data_agent, mcp tools), **Knowledge** (vector indexes, file uploads), **Triggers**, **Threads** retention policy
- Agent details: **Test** (interactive chat), **Threads** list, **Tracing** link, **Versions**, **Deploy** (publish + REST endpoint)

### Prompt flow (hub-based projects only)
- Flow list: name, type (standard/chat/evaluation), runtime, last modified
- Author canvas: visual DAG editor (nodes for LLM, Python, Prompt, Embedding, Vector lookup), inputs, outputs, **Run** button, variant comparison
- **Runtime** picker (must select a hub compute instance as the runtime)
- **Deploy** button to publish flow as an online endpoint

### Evaluations
- Run list: name, status (Queued/Running/Completed/Failed), evaluators used (relevance, groundedness, coherence, fluency, safety, custom), dataset, model deployment, created, **Open results**
- **+ New evaluation** wizard: target (model deployment / agent / flow), data source (existing dataset, synthetic-data-gen, manual prompts), evaluator selection + thresholds, scheduling (one-shot or continuous monitoring)
- Result view: per-metric distribution, per-row scores, comparison against a baseline run, failure-case drill-down

### Tracing
- Trace list (last N hours): operation name, status, duration, span count, timestamp
- Per-trace waterfall view: nested spans, LLM call params, tool calls, custom-event timeline
- Filters: time range, operation, success/failure, agent/flow

### Threads (agents)
- Conversation list per agent: thread ID, last message preview, message count, user, last activity
- Thread detail: full message history, **Run steps**, tool calls, attached files, **Open in playground**, evaluation metrics overlay (if monitor is enabled)

### Data + indexes
- Two sub-tabs: **Indexes** (project-scoped vector indexes in AI Search), **Knowledge** (agent-attached knowledge sources)
- Index creation wizard: source (blob / OneLake / SharePoint / upload), chunking strategy, embedding model, target AI Search service + index name

### Datasets
- Cross-references the Dataset editor in this project's scope (see `dataset-parity-spec.md`)

### Playgrounds
- Sub-tabs: **Chat**, **Images**, **Audio**, **Video**, **Agents**
- Each playground: model/agent picker, system prompt textarea, parameters (temperature, top_p, max_tokens, frequency_penalty, presence_penalty), tool toggles (web search, file search, code interpreter), **Compare** mode (up to 3 models side-by-side), **Open in VS Code**, **View code** (multilingual snippets)

### Connections / Compute / Settings
- Same shape as the hub equivalents but scoped to project. Connections at this level are private to the project (not shared)
- Compute tab can attach hub-shared compute or create project-only instances
- Settings: **Members** (RBAC), **Properties** (display name, description, tags), **Delete project**

## What Loom has

The current Loom `ProjectEditor` (`apps/fiab-console/lib/editors/foundry-sub-editors.tsx` lines 98–230) is wired live to project-flavoured workspaces via:
- `GET /api/items/ai-foundry-project` → lists projects under the hub (`listProjects` filters all ML workspaces in the RG by `kind=project` and matching `hubResourceId`)
- `GET /api/items/ai-foundry-project/[id]` → returns a single project (`getProject`)
- `POST /api/items/ai-foundry-project` → creates a project (`createProject` with system-assigned identity, `kind=Project`, hubResourceId)
- `DELETE /api/items/ai-foundry-project/[id]` → deletes a project (`deleteProject`)

The current UI is a list-and-detail surface:
- New-mode: a create form (name, displayName, description) + a list table showing existing projects with their displayName, location, kind, provisioningState, createdAt
- Detail-mode: read-only display of one project's metadata, with a Delete button
- No model catalog browse, no deployments tab, no agents UI, no prompt flow surface, no evaluations grid (separate `EvaluationEditor` exists but is project-scoped via the data plane), no tracing tab (separate `TracingEditor` exists for the hub), no threads, no playgrounds, no data + indexes view, no connections-at-project-scope, no member RBAC

In short: Loom can CRUD the project resource itself, but the rich Foundry-portal experience (catalog → deploy → agent → eval → trace) lives in separate sibling editors that are not stitched into the project shell.

## Gaps for parity

1. **Left-rail navigation shell** — current editor is flat. Need a multi-section project shell that mirrors Foundry portal's left rail and routes Models/Agents/Flow/Evaluations/Tracing/Threads/Data/Playgrounds into this single editor instead of separate top-level items
2. **Model catalog browse** — no UI today. Needs the model-catalog REST (azure-ai-ml registries + system registries) plus filter sidebar + model-card drawer
3. **Models + endpoints inventory** — `listOnlineEndpoints` and `listDeployments` exist in the foundry client but are surfaced under the hub editor, not the project. Project-scoped traffic-split + capacity-update flows are absent
4. **Agents surface** — no Loom UI for Foundry Agent Service. Needs project-scoped agent CRUD via the AI Project REST (`/assistants` / `/agents` endpoints) plus tool config, threads viewer, test-chat panel
5. **Prompt flow stitched into project** — `PromptFlowEditor` exists but is reached as its own catalog item. Foundry portal makes flow a tab of the project; Loom should embed it
6. **Evaluations stitched into project** — same problem: `EvaluationEditor` exists, needs to be embedded as a project tab with the synthetic-data-gen option
7. **Tracing stitched into project** — `TracingEditor` queries App Insights at the hub level; needs to filter on this project's operations
8. **Threads viewer** — no Loom UI. Foundry exposes agent threads via the Agent Service data plane; missing entirely
9. **Playgrounds** — no Chat/Image/Audio/Video playgrounds in Loom. The Foundry portal makes these first-class; for parity we need at least the Chat playground wired to a project deployment via the AOAI Chat Completions REST
10. **Project-scoped connections** — Loom shows hub connections; project-scoped connections (private to one project) are not listed/managed
11. **Member RBAC** — no in-project RBAC pane (Foundry User / Foundry Developer / Foundry Manager roles at project scope)
12. **Project endpoint copy / "Open in VS Code"** — Foundry shows the project endpoint front-and-center for SDK use; we display only the discoveryUrl
13. **Project create wizard parity** — Foundry's create flow includes selecting Foundry-projects (CognitiveServices) vs hub-based projects; Loom only creates hub-based projects today

## Backend mapping

Project resources straddle ARM (lifecycle, RBAC, identity) and two data planes: AML data plane (`{region}.api.azureml.ms`) for flows/evals/jobs, and the Foundry / AI Project REST (`{endpoint}/agents/v1`, `{endpoint}/assistants`, `{endpoint}/threads`, `{endpoint}/runs`) for agents/threads/runs.

| Loom surface | Backend call |
|---|---|
| Project list / get / create / delete | `GET/PUT/DELETE /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.MachineLearningServices/workspaces/{project}?api-version=2024-10-01` (already wired) |
| Model catalog browse | `GET https://management.azure.com/subscriptions/{sub}/providers/Microsoft.MachineLearningServices/locations/{loc}/registries/{registry}/models?api-version=2024-10-01-preview` for system registries (`azureml`, `azure-openai`, `HuggingFace`) |
| Deployments / endpoints (project-scoped) | `GET {project}/onlineEndpoints` and `/onlineEndpoints/{ep}/deployments`; `PATCH` for traffic split and capacity |
| Agents CRUD | `POST/GET/PATCH/DELETE {project-endpoint}/agents/v1/assistants` (Foundry Agent Service) |
| Threads / runs | `GET {project-endpoint}/agents/v1/threads`, `/threads/{id}/messages`, `/threads/{id}/runs`, `/runs/{id}/steps` |
| Test chat (playground) | `POST {project-endpoint}/openai/deployments/{name}/chat/completions?api-version=2024-10-01-preview` |
| Prompt flow | `GET/POST/PUT/DELETE {region}.api.azureml.ms/flow/api/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.MachineLearningServices/workspaces/{project}/PromptFlows` (already wired) |
| Evaluations | `{project}/evaluations` data plane (already wired) |
| Tracing | App Insights `query` filtered by `operation_Name startswith "{projectName}"` (extend the existing `queryTraces`) |
| Project endpoint / discovery | from `properties.discoveryUrl` on the project resource |

The existing client already implements `listProjects`, `getProject`, `createProject`, `deleteProject`. New helpers required: `listModelCatalog(registry, filter)`, `listProjectDeployments`, `updateDeploymentTraffic`, agent CRUD (`createAgent`, `listAgents`, `updateAgent`, `deleteAgent`), `listThreads`, `getThread`, `sendChat`, `listProjectConnections`, `listProjectRoleAssignments`.

## Required Azure resources

- **Hub workspace** + **Project workspace** (already provisioned; new projects are created on demand via the existing `createProject` route)
- **Project endpoint** = `properties.discoveryUrl` (auto-populated by ARM at create time)
- **AI Services / Foundry account** bound to the hub (kind=AIServices) — provides agents/threads/runs/chat endpoints. Bicep needs to add the **AzureML Data Scientist** + **Cognitive Services User** role at project scope to `LOOM_UAMI_CLIENT_ID` so project-data-plane calls work
- **Optional**: AI Search service for indexes + RAG (`LOOM_AI_SEARCH_SERVICE`), AOAI deployments referenced by name. Both should surface a `MessageBar intent="warning"` with the bind hint if absent
- **Bicep** — extend `platform/fiab/bicep/modules/foundry/projects.bicep` to deploy 1+ default projects with the right role assignments out of the box

## Estimated effort

**4 focused sessions** to reach grade B (production-grade — works, looks good, real data, real backend):

- **Session N+1 (~2 hrs):** Left-rail project shell, Overview tab with quick-start cards + recent activity, embed existing `PromptFlowEditor` and `EvaluationEditor` and `TracingEditor` as inner tabs
- **Session N+2 (~3 hrs):** Models + endpoints inventory (list/traffic/capacity), Project connections list, Member RBAC pane
- **Session N+3 (~3 hrs):** Agents CRUD + Threads viewer + test-chat panel wired to Foundry Agent Service REST
- **Session N+4 (~2 hrs):** Model catalog browse + model-card drawer, Chat playground wired to AOAI chat-completions

A fifth session lands grade A+ (tests + bicep): Vitest unit tests on the agent-form shape and traffic-split math, a Playwright walk covering create-project → deploy-model → create-agent → send-message, and a bicep module that provisions a default project + role assignments out of the box.
