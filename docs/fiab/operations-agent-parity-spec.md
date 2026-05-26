# Loom Operations Agent Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `ops-agent-parity-2026-05-26`. Sources: Microsoft Learn — [Create and configure operations agents](https://learn.microsoft.com/fabric/real-time-intelligence/operations-agent), [Operations agent transparency note](https://learn.microsoft.com/fabric/real-time-intelligence/operations-agent-transparency-note), [Operations Agent definition (REST)](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/operations-agent-definition), [Create an operations agent connected to ontology](https://learn.microsoft.com/fabric/iq/ontology/how-to-create-operations-agent), [Operations agent capacity and billing](https://learn.microsoft.com/fabric/real-time-intelligence/operations-agent-billing), [Operations agent best practices and limitations](https://learn.microsoft.com/fabric/real-time-intelligence/operations-agent-limitations). Cross-checked against the current Loom editor at `apps/fiab-console/lib/editors/phase4-editors.tsx::OperationsAgentEditor` (lines 865–898) and registry entry `'operations-agent'` in `apps/fiab-console/lib/editors/registry.ts`.

## What it is

A Fabric **Operations Agent (preview)** is a first-class Real-Time Intelligence workspace item that continuously monitors streaming data, evaluates rules against business goals, and recommends or autonomously executes actions through Microsoft Teams + Activator + Power Automate. Each agent targets one business process. Inputs are a **business goal**, a **knowledge source** (Eventhouse KQL DB or Ontology), free-text **instructions**, and a set of named **actions**. The agent uses an LLM at configuration time to synthesize a **playbook** of entities + rules, then evaluates that playbook against the data every 5 minutes once started.

The agent runs under the **delegated identity of its creator**: queries, action invocations, and Teams messages all flow with the creator's permissions. Conditions matched while running fire a Teams message; if the rule is marked **autonomous**, the action runs without confirmation.

## UI components

### Page chrome
- Title bar: agent name (editable inline) + auto-save indicator
- Standard Fabric global bar (search, notifications, settings, help, account)
- Right-side actions: **Share**, **Settings**, **View**
- **Start / Stop** toolbar toggle (the only way to change `shouldRun` in the item definition)

### Agent setup pane (primary surface)
Single scrollable form with the following sections:

| Section | Input | Notes |
|---|---|---|
| **Business goals** | Multi-line text | Free-text description of what to optimize, e.g. "Keep frozen products safe by monitoring freezer conditions." Drives the playbook generation. |
| **Instructions** | Multi-line text | Procedural guidance, e.g. "Monitor freezer temperature and keep below 20 °C." Imperative phrasing recommended. |
| **Knowledge source** | Add / remove picker | Currently one supported type: `KustoDatabase` (Eventhouse KQL DB) **or** an Ontology item. Picker shows workspace + database name; emits `dataSources` map keyed by user alias. |
| **Actions** | Add / remove + per-action config | Each action has `displayName`, `description`, `kind=PowerAutomateAction`, and optional `parameters[]` (name + description). At least one action recommended; agent always emits Teams notification regardless. |
| **Recipient** | Optional string | Defaults to the creator. Changing recipient does NOT change credentials — actions still run as creator. |

### Action configuration sub-flow
Selecting a not-yet-configured action opens **Configure custom action** drawer:
1. Pick workspace + **Activator item** in the same workspace
2. Create a **connection** (one-time per Activator + agent combination)
3. **Copy** the generated connection string
4. **Open flow builder** → builds a Power Automate flow triggered by the Activator connection
5. In flow builder, paste connection string → Save → action becomes "configured"

### Playbook view
- After **Save**, the agent emits a `playbook` JSON; the UI renders it as a tree of **Entities** (Concepts) → **Properties** (mapped to data columns) → **Rules** (LLM-generated conditions referencing the properties)
- Each rule has a **Make autonomous** toggle — flipping it lets the agent invoke the bound action without Teams approval
- Each rule shows the underlying property name; users are reminded to verify the LLM picked the right column
- **Regenerate playbook** button re-runs LLM synthesis after goal/instruction edits

### Run / monitoring panes
- **Start** in the toolbar flips `shouldRun=true` and activates 5-minute polling
- **Query insights** tab (on the underlying KQL DB) shows the agent's actual KQL — for auditing what the LLM authored
- **Teams notification card** sample preview pane (read-only) shows how a triggered recommendation will render in Teams (Fabric Operations Agent app)
- **Pause / Resume**: stopping the agent halts background usage; restarting re-arms the rules

### Capacity + billing sidebar
Three CU meters surface in the Fabric Capacity Metrics app and (in Fabric UI) as informational chips:
- **Copilot in Fabric** — used at config time (playbook generation)
- **Operations agent compute** — background rule evaluation
- **Operations agent autonomous reasoning** — LLM cycles when a condition fires

## What Loom has

The current `OperationsAgentEditor` (`apps/fiab-console/lib/editors/phase4-editors.tsx`, lines 865–898) is an honest config-only stub:

- A single `MessageBar intent="warning"` titled **"v2.1: configuration only — runtime deferred"** explaining the AI Foundry agents data-plane isn't wired
- Free-text **System prompt** textarea (no separate goals/instructions split)
- **Model** input (free text, defaults to `gpt-4o`)
- **Tools (comma)** input — invented field, no Fabric analogue
- **Eventhouse binding** input — accepts a Loom Cosmos item id
- **Ontology binding** input — accepts a Loom Cosmos item id
- `SaveBar` persists the bag to Cosmos via `useItemState('operations-agent', id, …)`
- No actions list, no playbook, no Start/Stop, no Teams preview, no Activator picker, no autonomous-rule toggle, no per-action Power Automate flow wiring, no recipient field, no capacity meter, no live rule evaluation

## Gaps for parity

1. **Goals vs instructions split** — Fabric requires two distinct fields with different LLM weighting (goals frame objectives; instructions constrain behavior). Loom collapses both into one `systemPrompt`.
2. **Knowledge-source picker** — today Loom asks for a free-text Cosmos id. Needs a typed picker over `eventhouse` + `ontology` Loom items with a Fluent ComboBox + KQL DB sub-selector.
3. **Actions section** — entirely missing. Need an add/remove list, per-action `displayName` + `description` + `parameters[]` editor, and a **Configure** drawer for the Activator + Power Automate flow handshake.
4. **Activator + Power Automate handshake** — Loom has an `activator` editor (`phase3-editors.tsx::ActivatorEditor`) but no flow from operations-agent UI to mint a connection string and open the flow builder. Cross-item launch is needed.
5. **Playbook generation + viewer** — no LLM round-trip to generate a playbook, no entity/rule tree, no per-rule autonomous toggle.
6. **Start / Stop toolbar** — Loom has no `shouldRun` flip; the Fabric item definition requires it as a top-level boolean.
7. **Recipient field** — missing entirely.
8. **English-only guardrail UX** — Fabric documents that goals + instructions must be English; Loom should surface this as inline help.
9. **Query insights surface** — no view into the KQL the agent is actually running. Required for audit trail (operations-agent transparency note explicitly calls this out as the limitation mitigation).
10. **Teams preview pane** — no "this is what a recommendation will look like in Teams" rendering.
11. **Capacity meter chips** — no surfacing of the three CU meters (Copilot in Fabric / agent compute / autonomous reasoning).
12. **Tools field is invented** — the current `tools: 'eventhouse-query, activator-trigger'` string is not a Fabric concept; it should be removed and the action list takes its place.
13. **Item-definition shape mismatch** — Loom Cosmos state doesn't match the Fabric REST `OperationsAgentDefinition` (`configuration{goals, instructions, dataSources{}, actions{}}` + `playbook{}` + `shouldRun`). Persisted shape needs to mirror the definition so future bicep-deployed agents can round-trip.

## Backend mapping

Operations agents are a Fabric-native item with no first-class Azure REST equivalent — the **closest Azure analogue is an Azure AI Foundry agent + Logic App + Stream Analytics combo**, but it does not give you the LLM-authored playbook or the 5-minute polling cadence. Loom's pragmatic backing strategy:

| Loom surface | Backing service | Notes |
|---|---|---|
| Agent config persistence (goals, instructions, sources, actions, playbook) | **Cosmos** (`loomdb / items` container, partition `operations-agent`) | Mirror the Fabric `OperationsAgentDefinition` JSON shape so future REST round-tripping is free |
| Playbook generation | **Azure OpenAI** (deployment `gpt-4o`) on the AI Foundry hub | Few-shot prompt that takes goals + instructions + source schema and returns the entity/rule tree |
| Knowledge-source — Eventhouse | Existing Loom `eventhouse` + `kql-database` editors | Cross-item picker reads Cosmos for available KQL DBs in the same workspace |
| Knowledge-source — Ontology | Existing Loom `ontology` editor | Same picker, filtered by `itemType=ontology` |
| Rule evaluation (the 5-min poll) | **Azure Function timer-trigger** (`func-csa-loom-eastus2 / ops-agent-evaluator`) | Reads the active playbook, executes each rule's KQL against the bound Eventhouse, fires actions on match |
| Action — Power Automate flow | **Power Automate connector** via the existing `power-automate-flow` editor | Connection string handshake mirrors Activator pattern |
| Action — Teams notification | **Microsoft Graph chatMessage API** | Default action even with no Power Automate flow configured |
| Activator binding | Existing Loom `activator` editor | Cross-item reference, identical to Fabric pattern |
| Audit (queries the agent ran) | **Log Analytics** + Eventhouse `.show queries` | Surfaces in the Query insights tab |

## Required Azure resources

The following must exist (and most already do in `platform/fiab/bicep/`):
- **Azure AI Foundry hub** + project (Cosmos `ai-foundry-hub` item already wired in v2.x; gpt-4o deployment for playbook synthesis)
- **Azure OpenAI** content safety + abuse-monitoring tenant settings enabled
- **Eventhouse + KQL DB** for the data source (existing modules `platform/fiab/bicep/modules/realtime/eventhouse.bicep` + `kql-database.bicep`)
- **Activator item** + **Power Automate connector** for action dispatch
- **Function App** (`func-csa-loom-eastus2`) with new function `ops-agent-evaluator` for the 5-minute poller (timer-triggered, MI access to Eventhouse + Graph)
- **Teams app** "Fabric Operations Agent" installed at tenant — required so recommendations land in the user's Teams; ship as a tenant-admin bootstrap step in `docs/fiab/v3-tenant-bootstrap.md`
- **Bicep + role assignments**: the Function MI needs `Database Viewer` on the bound Eventhouse, `Microsoft Graph Chat.ReadWrite` for Teams cards, and `Reader` on the Activator item

## Estimated effort

- **Session N+1 (~3 hrs)** — split goals/instructions, typed knowledge-source picker, actions list (Cosmos-only persistence, no Power Automate yet), Cosmos state migration to mirror `OperationsAgentDefinition`
- **Session N+2 (~3 hrs)** — playbook generation via AOAI + entity/rule tree viewer + per-rule autonomous toggle + Start/Stop toolbar wiring (writes `shouldRun`)
- **Session N+3 (~3 hrs)** — action Configure drawer (Activator + Power Automate handshake, reuse activator-editor connection plumbing), recipient field, Teams card preview pane
- **Session N+4 (~4 hrs)** — Function App `ops-agent-evaluator` (timer trigger, KQL execution, Graph chatMessage dispatch, Power Automate trigger), bicep module + role assignments, end-to-end UAT against a real Eventhouse

Total: **~13 hrs** spread across 4 focused sessions. Current grade: **D (stubbed)** — renders, persists to Cosmos, but no backing service. Target: **A+** after Session N+4 with bicep parity + Vitest/Playwright coverage.
