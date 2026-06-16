# Copilot Studio Topic Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Copilot Studio: authoring-create-edit-topics, authoring-triggers, authoring-variables, authoring-variables-about, authoring-system-topics, authoring-ask-a-question, advanced-entities-slot-filling, nlu-authoring, guidance/topic-authoring-best-practices, guidance/triggering-topics) + inspection of `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotTopicEditor` and `listTopics` / `upsertTopic` in `apps/fiab-console/lib/azure/copilot-studio-client.ts`.

## Overview

Topics are the conversation primitives in Copilot Studio (classic mode) and the structured fallback in generative mode. Each topic is a dialog flow: a directed graph of nodes that runs when a trigger fires. Triggers come from the NLU model (user utterance matched against trigger phrases), explicit `Redirect` calls from other topics, or system events (Conversation Start, Fallback, Escalate, On Error, custom event, inactivity). The orchestrator in generative mode selects topics dynamically using the topic name + description as routing hints. Topics support input/output variables for reuse across the agent.

## Copilot Studio UX

### Topics page chrome
- Tabs: **Custom topics** · **System topics**
- List columns: name · status (On/Off) · trigger phrases (preview) · last-modified · who-modified
- Row actions: **Open** · **Turn off** · **Copy** · **Delete** · **Export YAML**
- Top-right: **Add a topic** dropdown — `Create from blank` · `Create from description with Copilot` · `Suggested topics` (AI-generated from agent description)

### Authoring canvas
- Free-form canvas with draggable nodes connected by anchor lines
- **Trigger** node at top (auto-created) — kind: `Phrases` (user utterance) · `Event` (Conversation Start / Inactivity / Custom event / Activity received) · `On unknown intent` (Fallback only)
- **Add node** (+) opens a menu of node types (below)
- Right-side **Properties** pane edits the selected node
- **Save** + **Test your agent** chat panel (always uses latest unsaved draft)

### Node types

| Node | Configuration |
|---|---|
| **Send a message** | Rich-text editor with bold/italic/lists/hyperlinks · variable insertion (`{x}` picker) · adaptive cards · suggested replies (chips) · speech SSML override |
| **Ask a question** | Question text · **Identify**: prebuilt entity (`Number`, `Date and time`, `Person name`, `Email`, `Phone number`, `City`, `Country/region`, `Money`, etc.) / closed list / regex / multiple-choice / dynamic / one-of-multiple / user's entire response · **Options for user** (multiple-choice buttons) · variable name · **Include metadata** (literal + value) · **Additional entity validation** (Power Fx) · **No valid entity found** behavior (Escalate / Set default / Set empty) · **Interruption** (allow switching to another topic — restrictable to specific topics) · **Reprompt** count |
| **Add a condition** | Branch based on Power Fx expression over variables · `Branch for all other conditions` (else) · multiple branches |
| **Call an action / Call a tool** | Pick Power Automate flow · prebuilt connector action · custom connector action · AI prompt (Foundry-deployed) · authentication node · Bot Framework skill |
| **Redirect to another topic** | Pick destination topic · pass **input variables** to it · returns to current node when subtopic completes (unless redirecting to End/Escalate/Goodbye system topics, which end the conversation) |
| **Variable management** | Set variable value · Parse value (string → record) · Clear variable values (specific / all / conversation history) |
| **Show typing indicator** | Adaptive delay |
| **End the conversation** | `End with survey` (CSAT) · `Transfer to agent` (Omnichannel handoff, optional private message) · `Goodbye` |
| **Generative answers** | Knowledge sources subset · per-node knowledge override · suppress citations · prompt modification |
| **Adaptive Card** | Author or paste card JSON; bind to variables |

### Variables
- **Scope**: `Topic` (current topic) · `Global` (agent-level, persists across topics) · `User` (per-user, persists across sessions) · `System` (read-only: `User.DisplayName`, `Conversation.Id`, `Conversation.LocalTimeZone`, `Activity.From.Id`, `UnrecognizedTriggerPhrase`)
- **Data types**: `String` · `Number` · `Boolean` · `Date and time` · `Record` · `Table` · `Choice` (enum) · `File`
- **Variable properties pane**: name · type · `Receive values from other topics` (input parameter) · `Send to other topics` (output parameter) · default value · sensitive (PII flag)

### Slot filling + entity extraction
- When a Question node uses a prebuilt entity, the NLU model can pre-fill the answer from the initial utterance (e.g. user says "block my credit card" → `CardType=Credit` and `Operation=Block` are extracted before the Question runs)
- Multiple-choice options auto-generate conditional branches per option

### Trigger phrases panel
- Inline list of user utterances (5–10 recommended) that should fire the topic
- AI suggests more phrases based on existing ones (`Suggest phrases`)
- Confidence / overlap warning if phrases collide with other topics
- **Description** (orchestrator-routing hint in generative mode) — separate from trigger phrases

### System topics (built-in, can't delete)
Conversation Start · Conversational boosting · End of Conversation · Escalate · Fallback · Multiple Topics Matched · On Error · Reset Conversation · Sign in · Start over · Thank you · Goodbye · Confirmed Success · Confirmed Failure

## What Loom has today

From `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotTopicEditor` and `app/api/items/copilot-studio-topic/**`:
- Env picker + agent picker (shared with agent editor)
- List topics (`GET /msdyn_botcomponents?$filter=componenttype eq 9 and _msdyn_copilotid_value eq {agentId}`)
- Per-topic row: name · trigger-phrase count · modified-on
- **Structured topic canvas** (default, audit H4) — a typed step list: Trigger phrases + an
  ordered sequence of Message / Question / Condition / Action nodes, each with its own Fluent v9
  form, serialized to/from the AdaptiveDialog YAML via `lib/copilot-studio/topic-model.ts`. A
  "Code view" toggle still exposes the raw YAML (Monaco), and any AdaptiveDialog construct the
  structured model can't represent is preserved verbatim as a read-only "Advanced (YAML)" node so
  round-tripping is lossless. The raw-YAML textarea is no longer the primary surface
  (ui-parity / loom_no_freeform_config).
- POST/PATCH to `/msdyn_botcomponents` writing `data={triggerPhrases, flowYaml}` + `content=flowYaml`
- **Delete topic**
- MessageBar for Copilot-Studio-not-enabled 503

## Gaps for parity

1. **Visual canvas** — PARTIAL (audit H4): Loom now ships a structured step-list editor (ordered
   nodes with move-up/down + add menu) and a code-view toggle. Still missing vs the full Copilot
   Studio canvas: a true node graph with drag-and-drop and anchor-line editing.
2. **Node-type forms** — PARTIAL: typed forms now exist for Message · Question · Condition · Action.
   Still missing typed panes for Redirect · End · Generative answers · Adaptive Card · Variable
   management · Show typing (these fall back to the Code view / "Advanced (YAML)" node).
3. **Question node entity picker** — no dropdown of prebuilt entities (`Number`, `Date and time`, `Person name`, etc.); no closed-list / regex / multiple-choice authoring
4. **Slot filling** — Loom can't model `Include metadata` / `Additional entity validation` (Power Fx) / `No valid entity found` behavior
5. **Variables UI** — no variable browser with scope/type/`Receive from other topics`/`Send to other topics`; no `{x}` insertion picker inside Message text
6. **Trigger configuration** — Loom shows phrases only; no event-trigger kind (Conversation Start / Inactivity / Custom event / Activity received), no `On unknown intent`
7. **Description field** — Loom doesn't expose the topic description used by the orchestrator for generative routing
8. **Trigger-phrase suggestions + overlap detection** — no AI-suggest, no collision warning
9. **System-topics tab** — Loom only lists custom topics (filtered by `componenttype=9`); system topics + their overrides not exposed
10. **Topic from description with Copilot** — no natural-language topic generation entry point
11. **Suggested topics** — no list of AI-generated topics seeded from agent description
12. **Per-topic Test panel** — no in-context chat to test the topic in isolation
13. **Topic on/off toggle** — `statecode` not surfaced; only delete
14. **Topic export/import** — Loom has flowYaml in/out but no `.zip` export with related variables/skills
15. **Adaptive Card visual designer** — no card-builder UI
16. **Generative answers node** — no per-node knowledge-source picker
17. **Power Automate flow picker** — Loom can't browse the env's flows from inside a Call-action node
18. **Redirect target picker** — no dropdown of topics; raw YAML only
19. **Input/output variable binding on Redirect** — not visualized
20. **Validation** — no YAML schema-validation on save (broken topic flows currently save and fail at runtime)

## Backend mapping

Dataverse Web API:
- **Topic CRUD** — `msdyn_botcomponents` (id · name · `componenttype=9` for topics · `data` JSON · `content` YAML · `_msdyn_copilotid_value` · modifiedon)
- Topic flow YAML conforms to the **Bot Framework Composer / Copilot Studio dialog schema** (kind: `OnUnknownIntent` / `OnConvUpdateActivity` / etc.; actions: `Microsoft.SendActivity` / `Microsoft.TextInput` / `Microsoft.IfCondition` / `Microsoft.BeginDialog` / etc.) — but Copilot Studio uses its own simplified YAML schema documented at `microsoft-copilot-studio/authoring-yaml` (`kind: SendActivity` / `Question` / `ConditionGroup` / `InvokeFlowAction` / `Redirect` / `EndDialog`)
- **System topic overrides** — `msdyn_botcomponents` with `componenttype=9` + name matching the system-topic key (`ConversationStart`, `Fallback`, `Escalate`, etc.)
- **Variables** — declared inline in the topic YAML (`inputs:`, `outputs:`, `variables:`); global variables live in `msdyn_botvariables` (separate table)
- **Trigger phrases** — stored in topic YAML under `triggers:` section, and also indexed in `msdyn_botcomponents.data.triggerPhrases` for NLU model training
- **NLU model training** — implicit; happens via bound action `msdyn_TrainCopilot` when topics change (Loom doesn't call this — manual publish triggers it)

## Required Azure resources / tenant settings

- All Agent-editor prerequisites
- **Dataverse search enabled** (for NLU model training)
- **Copilot Studio Maker** security role (or higher) on the SP for `msdyn_botcomponents` CRUD
- **For Call-action nodes**: target Power Automate flow must exist in the env (`msdyn_flow` table) and the SP must have `prvReadProcess` privilege
- **For Generative answers nodes**: Foundry-deployed model or default GPT-4o family must be set as the agent's model deployment
- **No new Azure resources** beyond the agent's prerequisites

## Estimated effort

5–6 sessions — this is the largest editor by far. Visual canvas (node graph + drag-drop + anchor lines + add-node menu) is ~2 sessions (React Flow or equivalent + custom node-renderer per node type). Typed Properties pane for the seven core node types (Message / Question / Condition / Call action / Redirect / End / Generative answers) is ~2 sessions. Variable browser + `{x}` insertion picker + trigger config (event triggers + system topics + description) is ~1 session. AI-assist (Copilot natural-language topic generation + suggested topics + trigger-phrase suggestions) is ~1 session. Adaptive Card visual designer can be a separate ~2-session follow-on if scope tight.
