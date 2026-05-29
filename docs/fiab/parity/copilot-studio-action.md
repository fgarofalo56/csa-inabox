# copilot-studio-action — parity with Copilot Studio (actions)

Source UI: Copilot Studio → agent → Actions.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/advanced-plugin-actions>

## Feature inventory

1. List bound actions.
2. Bind action (Power Automate flow / custom connector / prebuilt).
3. Remove action.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | `msdyn_bot_actions` |
| Bind | built ✅ | type dropdown + flow/connector id |
| Remove | built ✅ | per-row Remove |

## Backend per control

- `listActions`/`bindAction`/`deleteAction` (Dataverse `msdyn_bot_actions`).
