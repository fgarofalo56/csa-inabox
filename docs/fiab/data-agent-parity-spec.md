# Loom Data Agent Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `data-agent-parity-2026-05-26`. Sources: Microsoft Learn — [Create a Fabric data agent](https://learn.microsoft.com/fabric/data-science/how-to-create-data-agent), [Fabric data agent concepts](https://learn.microsoft.com/fabric/data-science/concept-data-agent), [Configure your data agent](https://learn.microsoft.com/fabric/data-science/data-agent-configurations), [Configure Fabric data agent tenant settings](https://learn.microsoft.com/fabric/data-science/data-agent-tenant-settings), [Consume Fabric data agent from Microsoft Foundry Services](https://learn.microsoft.com/fabric/data-science/data-agent-foundry), [Consume a Fabric Data Agent in Microsoft Copilot Studio](https://learn.microsoft.com/fabric/data-science/data-agent-microsoft-copilot-studio), [Fabric data agent end-to-end tutorial](https://learn.microsoft.com/fabric/data-science/data-agent-end-to-end-tutorial). Cross-checked against the current Loom editor at `apps/fiab-console/lib/editors/phase4-editors.tsx::DataAgentEditor` (lines 900–943) and registry entry `'data-agent'` in `apps/fiab-console/lib/editors/registry.ts`.

## What it is

A Fabric **Data Agent (preview)** is a first-class Data Science workspace item that exposes a natural-language Q&A surface over governed OneLake data. Under the hood the agent calls the **Azure OpenAI Assistants API** to plan a query, generate SQL/DAX/KQL, execute it against an attached data source, and return a natural-language answer with the underlying query visible for inspection. A single agent can ground on **up to five data sources** in any combination of: Lakehouse, Warehouse, Power BI semantic model, KQL DB (Eventhouse-backed), Ontology, or Microsoft Graph.

Data agents have **two versions**: a draft (refined in the builder) and a published version (shared with consumers and consumed externally). Once published, the agent is reachable via a Fabric endpoint shaped `https://<env>.fabric.microsoft.com/groups/<workspace_id>/aiskills/<artifact_id>` and can be added as a tool inside **Azure AI Foundry agents** (via `FabricTool`) or **Microsoft Copilot Studio** custom agents. Consumers need at least `READ` on the data agent plus the per-source minimum (Build on PBI semantic models, Read on Lakehouse/Warehouse, Reader on KQL DB).

## UI components

### Page chrome
- Title bar: agent name (editable inline at create time and via Settings) + saved-state indicator
- Standard Fabric global bar (search, notifications, settings, help, account)
- Right-side actions: **Share**, **Settings**, **Publish**, **View**
- Top toolbar: **Save**, **Publish**, **Diagnostics**, version switcher (Draft / Published)

### Left pane — Data sources panel
- Header **Data sources** + count chip (`N / 5`)
- **+ Add data source** button → modal lets the user pick a source type then resolve it:
  - **Lakehouse** — workspace picker → lakehouse picker → then **table picker** (select only the tables the agent should use; files are NOT supported, ingest first)
  - **Warehouse** — workspace + warehouse + table picker
  - **Power BI semantic model** — workspace + model picker (consumer needs `Build`, not just Read)
  - **KQL database (Eventhouse-backed)** — workspace + eventhouse + KQL DB + table picker (encourage time filters for high-volume telemetry)
  - **Ontology** — workspace + ontology item (preview)
  - **Microsoft Graph** — connector-style picker (preview)
- Each attached source becomes a node in the left tree; expanding it reveals the **selected tables / models**

### Per-source configuration drawer
Clicking an attached source opens a configuration drawer with:
- **Source name** + read-only ID
- **Selected tables / model** sub-picker (add/remove tables without re-attaching)
- **Data source instructions** — multi-line text using a structured template:
  ```md
  ## General knowledge
  ## Table descriptions
  ## When asked about
  ```
- **Example queries** — repeating editor of `question → SQL/DAX/KQL` pairs (few-shot pairs; few-shot is the headline accuracy lever)

### Agent-level instructions pane
- **Data agent instructions** button opens a full-screen editor (up to **15,000 characters**)
- Free-text English-only instructions; recommended pattern is to declare which data source handles which question type, e.g. "Route financial metrics to the PBI semantic model; raw exploration to the lakehouse; log analysis to the KQL DB"
- Inline character counter and lint hints (e.g. "no instructions yet — add at least one routing rule")

### Test / chat pane (right side, primary surface during draft)
- Conversation history with the agent
- User prompts on the right, agent responses on the left
- Each agent message shows:
  - Natural-language answer
  - **Generated query** expander (SQL / DAX / KQL) with copy button
  - **Source used** badge
  - Thumbs-up / thumbs-down feedback
- **New thread** button resets context
- Threads are scoped to the draft; not persisted post-publish

### Publish dialog
- **Publish** button opens a dialog asking for a **description** (multi-line) that orchestrators + colleagues will see when invoking the agent — important because Foundry agents read this string to decide when to call the Fabric tool
- After publish: shows the **published endpoint URL** + the `workspace_id` and `artifact_id` GUIDs that external Foundry / Copilot Studio connections need (both marked as secrets in the consumer)

### ALM, diagnostics, governance surfaces
- **Diagnostics** tab — agent runs, latency, success rate, query failure samples
- **Git integration** — author/edit data-agent config in source control (instructions, examples, source selection are versioned text)
- **Deployment pipelines** — promote draft from dev → test → prod workspaces
- **Purview** — applies sensitivity labels + access policies at the source level; agents inherit them

### Consume — external surfaces (information only in the editor)
The editor doesn't host these but should link to them:
- **Azure AI Foundry**: `FabricTool` add via the Foundry portal (Agents → Knowledge → Add → Microsoft Fabric → new connection with `workspace-id` + `artifact-id` as secrets)
- **Microsoft Copilot Studio**: Agents pane → `+ Add` → Microsoft Fabric → pick this published agent
- **Microsoft 365 Copilot**: published agents surface in M365 Copilot with Purview policies honored

## What Loom has

The current `DataAgentEditor` (`apps/fiab-console/lib/editors/phase4-editors.tsx`, lines 900–943) is a config-only stub:

- A `MessageBar intent="warning"` titled **"v2.1: configuration only — runtime deferred"** explaining live chat against AI Foundry will land in a later release
- Free-text **System prompt / AI instructions** textarea (no character counter, no template scaffolding)
- **Model** input (free text, default `gpt-4o`) — invented; real Fabric data agents do not let the author pick the NL2SQL model (only the orchestrator model on the *consumer* side)
- **Sources (free text)** input — single comma-separated string, no typed picker
- **Synapse Serverless SQL endpoints**, **KQL databases**, **Lakehouse paths** — three separate free-text inputs (none correspond to Fabric's typed source picker, and Synapse Serverless isn't a Fabric data-agent source type)
- **Example queries (one per line)** textarea — flat list, not the question→query few-shot pair format Fabric requires
- `SaveBar` persists the bag to Cosmos via `useItemState('data-agent', id, …)`
- Ribbon has a **Chat preview** label but is not wired
- No publish, no draft/published version split, no per-source instructions drawer, no test chat pane, no diagnostics, no Foundry connection mint, no Copilot Studio handoff

## Gaps for parity

1. **Five-source typed picker** — replace the three free-text endpoint fields with the proper add-source modal covering Lakehouse / Warehouse / PBI semantic model / KQL DB / Ontology / Graph. Enforce 5-source max.
2. **Per-source table selection** — Fabric requires selecting specific tables (or model) per source; Loom has no concept of this.
3. **Per-source instructions drawer** — the `## General knowledge / ## Table descriptions / ## When asked about` template editor is entirely missing.
4. **Example queries as question→query pairs** — current flat textarea must become a repeating two-field editor (NL question on top, generated SQL/DAX/KQL underneath) so few-shot learning actually works.
5. **15,000-character instructions surface** — needs a dedicated full-screen instructions editor with a character counter, not the shared 5-row textarea.
6. **Remove invented Model picker** — Fabric data agents don't let authors choose the NL2SQL model; the consumer (Foundry / Copilot Studio) picks its orchestrator model. Strip this field.
7. **Remove Synapse Serverless SQL endpoints field** — not a supported Fabric data-agent source. (If we want Synapse-bound semantics on Loom, expose it as a Warehouse-alias source.)
8. **Draft vs Published version model** — Cosmos state needs to mirror the dual-version model; today a single bag is overwritten on save.
9. **Publish dialog + published endpoint** — no "Publish" button, no description prompt, no surfacing of the `workspace_id / artifact_id` pair that downstream Foundry connections need.
10. **Test chat pane** — no conversation surface, no rendered SQL/DAX/KQL expander on agent replies, no per-message source badge, no feedback thumbs.
11. **Diagnostics tab** — no run history, latency, failure-sample surface.
12. **Foundry connection handoff** — no UX to mint or surface the `FabricTool` connection (workspace-id + artifact-id with `is_secret=true`) to be pasted into a Foundry project's Connected Resources.
13. **Copilot Studio handoff** — no link or instructions to add this agent under Copilot Studio's Agents pane.
14. **Purview / sharing model** — share dialog absent; per-source minimum permission documentation absent.
15. **Tenant-settings gate** — Fabric requires admin enable of operations-agent + Copilot + cross-geo AI processing tenant settings; Loom should surface a `MessageBar` if those aren't on (and link to `docs/fiab/v3-tenant-bootstrap.md`).
16. **User-identity-only auth** — service-principal auth isn't supported for Fabric data agents; the test chat must use the signed-in Loom user's delegated token, not the platform SP.

## Backend mapping

The Fabric Data Agent itself is a Fabric-native item, but its runtime is the **Azure OpenAI Assistants API** plus the source-specific query engines (TDS for Warehouse, ADBC/Spark for Lakehouse, KQL endpoint for KQL DB, DAX/XMLA for PBI semantic models). Loom's backing strategy:

| Loom surface | Backing service | Notes |
|---|---|---|
| Agent config persistence (instructions, sources, per-source instructions, examples, description, draft + published versions) | **Cosmos** (`loomdb / items`, partition `data-agent`) | Mirror Fabric's draft/published split so external connections always point at the published GUID |
| NL2SQL planning + tool dispatch | **Azure OpenAI Assistants** on the AI Foundry hub (`aifoundry-csa-loom-eastus2`) | One assistant per published agent; tools per attached source |
| Lakehouse source | Existing Loom `lakehouse` editor + Synapse Spark / Databricks SQL endpoint | Tool runs Spark SQL against the table list |
| Warehouse source | Existing Loom `warehouse` editor (or `synapse-dedicated-sql-pool` alias) | Tool runs T-SQL via TDS over Private Endpoint with AAD MI |
| KQL DB source | Existing Loom `kql-database` editor | Tool runs KQL via the KQL DB endpoint |
| Power BI semantic model source | New Loom `semantic-model` editor wiring | Tool runs DAX via XMLA / executeQueries REST |
| Ontology source | Existing Loom `ontology` editor (preview) | Tool resolves entity/property queries |
| Test chat pane | Loom BFF route → Assistants `threads.messages.create` + `runs.create` | Each turn streams back the natural-language answer + the underlying tool query for the expander |
| Publish | Cosmos write (flip `publishedAt`, snapshot config) + emit the published GUID pair | The GUID pair is the artifact id Foundry connections paste in as secrets |
| Diagnostics | **Log Analytics** + Cosmos `runs` sub-container | Latency, failures, token counts |
| Sharing + Purview policy enforcement | Existing Loom share flow + Purview labels on the underlying source items | Per-source minimum-permission checks pre-flight in the editor |
| Foundry consumption | External — Foundry portal Management Center → Connected resources → new **Microsoft Fabric** connection with `workspace-id` + `artifact-id` as secrets | Surface as a "Connect to Foundry" link with the two GUIDs copyable |
| Copilot Studio consumption | External — Copilot Studio Agents pane → Add → Microsoft Fabric → pick agent | Surface as a "Use in Copilot Studio" deep link |

## Required Azure resources

The following must exist (most already wired in `platform/fiab/bicep/`):
- **Azure AI Foundry hub** + project (already deployed; gpt-4o deployment used for NL2SQL planning)
- **Azure OpenAI** with Content Safety integration + abuse-monitoring tenant settings enabled
- **Cross-geo AI processing tenant setting** enabled (required outside US/EU regions per Fabric data-agent tenant settings)
- **Azure AI Search** (optional but recommended for retrieval over per-source instructions / few-shot examples — reuse existing `loom-items` index plus a new `data-agent-instructions` index)
- At least one **bound data source** from: Lakehouse, Warehouse, KQL DB (Eventhouse), Power BI semantic model, Ontology — each already deployable via existing bicep modules
- **AAD app role assignments** so the signed-in Loom user can be granted: `Build` on PBI semantic models, `Read` on Lakehouse/Warehouse, `Reader` on KQL DB, `READ` on the data agent itself (these are user-level, not MI — Fabric data agents are user-identity-only)
- **AI Foundry RBAC**: developers need `Foundry User` (formerly Azure AI User) for the Foundry-side consumption demo
- **Purview** account + scanned data sources for governance policy enforcement (already in bicep)
- **Tenant admin steps** (document in `docs/fiab/v3-tenant-bootstrap.md`): enable Fabric data-agent tenant setting, enable Microsoft Copilot in Fabric tenant setting, enable cross-geo AI processing if applicable

## Estimated effort

- **Session N+1 (~3 hrs)** — typed five-source picker + per-source table selection + remove invented Model/Synapse-Serverless fields + Cosmos state migration to source-array shape
- **Session N+2 (~3 hrs)** — per-source instructions drawer with the structured template + question→query pair editor + 15k-char agent-level instructions full-screen editor
- **Session N+3 (~3 hrs)** — test chat pane (Assistants API integration, streaming responses, SQL/DAX/KQL expander, source badge, feedback thumbs)
- **Session N+4 (~2 hrs)** — Publish flow (description prompt, draft/published version split, surface workspace_id/artifact_id pair with copy-to-clipboard for Foundry connection mint)
- **Session N+5 (~3 hrs)** — Diagnostics tab, sharing + Purview pre-flight, Foundry/Copilot-Studio handoff links, tenant-settings MessageBar gate
- **Session N+6 (~2 hrs)** — Vitest + Playwright coverage; end-to-end UAT publishing a draft and consuming it from a real Foundry project

Total: **~16 hrs** spread across 6 focused sessions. Current grade: **D (stubbed)** — renders, persists to Cosmos, but no backing service and several invented fields. Target: **A+** after Session N+6 with bicep parity + tenant-bootstrap docs + Vitest/Playwright coverage.
