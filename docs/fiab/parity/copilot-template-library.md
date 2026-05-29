# copilot-template-library — parity with Copilot Studio (agent templates)

Source UI: Copilot Studio → Create → templates gallery.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/authoring-first-bot>

## Feature inventory

1. Template gallery grouped by category.
2. Template detail (description, suggested model, knowledge/topic counts).
3. "Use template" → instantiate an agent in the target environment.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| Gallery | built ✅ | category-grouped cards (Cosmos-backed) |
| Detail | built ✅ | description, model, knowledge/topic badges |
| Use template | built ✅ | creates agent + knowledge + topics in selected env |

## Backend per control

- List → `GET /api/items/copilot-template-library`
- Use → `POST .../[id]` — creates a real `msdyn_copilots` agent and seeds knowledge/topics via the Dataverse Web API.
