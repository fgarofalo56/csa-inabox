# copilot-studio-topic — parity with Copilot Studio (topics)

Source UI: Copilot Studio → agent → Topics.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/authoring-create-edit-topics>

## Feature inventory

1. List topics.
2. Create / edit topic (name, trigger phrases, flow definition).
3. Delete topic.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | `msdyn_botcomponents` componenttype 9 |
| Create/edit | built ✅ | name + trigger phrases + Monaco YAML editor; Ctrl+S; dirty guard |
| Delete | built ✅ | per-card Delete |

## Backend per control

- `listTopics`/`getTopic`/`upsertTopic`/`deleteTopic` (Dataverse `msdyn_botcomponents`).
