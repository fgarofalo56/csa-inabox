# copilot-studio-knowledge — parity with Copilot Studio (knowledge)

Source UI: Copilot Studio → agent → Knowledge.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/knowledge-add-file-upload>

## Feature inventory

1. List knowledge sources.
2. Add source (URL / file / SharePoint / Dataverse table).
3. Remove source.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | `msdyn_knowledgesources` |
| Add | built ✅ | type dropdown + name + URI |
| Remove | built ✅ | per-row Remove |

## Backend per control

- `listKnowledgeSources`/`addKnowledgeSource`/`deleteKnowledgeSource` (Dataverse `msdyn_knowledgesources`).
