# copilot-studio-action — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/copilot-studio-action/new`
**Fabric reference**: copilotstudio.microsoft.com — Actions tab (Add action wizard: Power Automate flow / Connector / Prebuilt / Custom Skill)
**Loom screenshot**: `temp/parity/copilot-studio-action-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/copilot-studio-action?envId=<env>&agentId=test` | **404** with body `Resource not found for the segment 'msdyn_bot_actions'` | The Dataverse `msdyn_copilots` schema is not deployed in this env — exactly the gap the prompt warned about |

The editor still renders the **Copilot Studio not enabled** MessageBar (the BFF maps 404 from missing schema to the same honest message). UI shows Action name · Type dropdown (Power Automate flow / Custom connector / Prebuilt) · Flow id · Connector id · Bind button.

## Phase 3 — Fabric vs Loom

| Copilot Studio element | Loom present? | Severity |
|---|---|---|
| Type dropdown (3 types) | YES | — |
| **Power Automate flow picker** (live list of flows in env) | NO — free text Flow id | MAJOR |
| **Custom connector picker** | NO — free text Connector id | MAJOR |
| **Prebuilt action catalog** (Excel · SharePoint · Outlook · Teams · etc.) | NO | MAJOR |
| **Input/output parameter mapping** (agent variable → flow input) | NO | BLOCKER |
| **Description + when-to-use prompt** that the LLM uses for tool selection | NO | BLOCKER — this is what makes generative orchestration work |
| **Test action** (provide sample inputs, fire the flow, see response) | NO | MAJOR |
| Honest 404/503 MessageBar | YES | — |
| Bound actions list | YES (empty here) | — |

## Functional

- 404 from `msdyn_bot_actions` correctly surfaces as the "Copilot Studio not enabled" MessageBar
- Bind button wired to POST (not exercised due to schema absence)

## Grade — **F**

Two BLOCKERs (no parameter mapping, no description-for-tool-selection) and free-text Flow/Connector IDs make this unusable for real action authoring. The 404 → honest MessageBar is correct, but the underlying surface is far below parity. **Grade F.**
