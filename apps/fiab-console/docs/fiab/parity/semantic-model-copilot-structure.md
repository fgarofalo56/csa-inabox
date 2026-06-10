# semantic-model-copilot-structure — parity with Fabric "Copilot for semantic models" (model structure)

Source UI: Microsoft Fabric — Power BI semantic-model editing with Copilot (Build 2026 #26: "Copilot modifies semantic models"); Tabular Editor / Power BI Desktop model-structure edits over XMLA TMSL.
Learn refs:
- TMSL Alter command — https://learn.microsoft.com/analysis-services/tmsl/alter-command-tmsl
- TMSL createOrReplace — https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
- Measures object (description, formatString, displayFolder) — https://learn.microsoft.com/analysis-services/tmsl/measures-object-tmsl
- Relationships object — https://learn.microsoft.com/analysis-services/tmsl/relationships-object-tmsl

## Fabric / Power BI feature inventory (model-structure editing with Copilot)

1. Natural-language request to change the model structure.
2. Rename a measure (and the engine preserves its expression + metadata).
3. Write / edit descriptions on measures, columns, and tables (the surface auto-describe targets).
4. Suggest + create relationships between tables.
5. Review proposed changes before they are applied (Copilot proposes; the modeler approves).
6. Undo / revert applied changes (version history / checkpoints).
7. Grounding in the real model metadata so Copilot references existing object names.

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | NL request → structured edits | ✅ built | `POST /copilot-structure` calls the real Azure OpenAI chat deployment; returns a fixed structured-edit JSON contract. |
| 2 | Rename measure | ✅ built | `rename-measure` edit → Cosmos content + opt-in `buildRenameMeasureTmsl` Alter (addresses old name, sets new). |
| 3 | Descriptions (measure / column / table) | ✅ built | `set-description` edit → Cosmos + opt-in `buildMeasureDescriptionTmsl` / `buildColumnDescriptionTmsl` / `buildTableDescriptionTmsl` Alters. |
| 4 | Suggest + create relationships | ✅ built | `add-relationship` edit → Cosmos + opt-in `buildAddRelationshipTmsl` createOrReplace. |
| 5 | Review before apply | ✅ built | Pane lists proposals with per-edit checkboxes; invalid edits (referencing missing objects) are disabled with the reason. |
| 6 | Undo / revert | ✅ built | Auto-checkpoint before every apply + manual "Checkpoint now" + one-click Restore (restore is itself reversible). Checkpoints persist in Cosmos content (`copilotCheckpoints`). |
| 7 | Real-metadata grounding | ✅ built | `renderStructureCatalog` feeds the live table/column/measure catalog into the Copilot system prompt; server validates every edit against the snapshot. |
| — | Azure OpenAI not configured | ⚠️ honest-gate | 503 `code:'no_aoai'` + MessageBar naming `LOOM_AZURE_OPENAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` + the OpenAI User role. Checkpoints/restore still work. |
| — | Live tabular write | ⚠️ honest-gate | Default is Loom-native (Cosmos). Live XMLA write is opt-in via `LOOM_AAS_SERVER_URL` (Azure Analysis Services) or `LOOM_POWERBI_XMLA_ENDPOINT`; disclosed in a Badge + per-edit backend status. |

Zero ❌ — every inventory row is built or honest-gated.

## Backend per control

- Propose edits → `POST /api/items/semantic-model/[id]/copilot-structure { prompt }` → Azure OpenAI `chat/completions` (`resolveAoaiTarget`, UAMI token on the Cognitive Services scope), `response_format: json_object`. Server `coerceEdits` + `validateEdit`.
- Apply edits → `PUT … { edits, label? }` → auto-checkpoint to Cosmos, `applyEditToSnapshot` per edit, persist content; opt-in `executeXmlaCommand(TMSL)` per edit when `aasXmlaConfig()` resolves.
- Manual checkpoint → `POST … { action:'checkpoint' }` → Cosmos.
- Restore → `POST … { action:'restore', checkpointId }` → snapshots current state, rolls content back, persists.
- Delete checkpoint → `DELETE …?checkpointId=`.
- Load → `GET …` → structure snapshot + checkpoint list + `aoaiAvailable` + `xmla.available`.

## No-Fabric-dependency

The full pane (load, propose, apply, checkpoint, restore) operates on Loom-native content in Cosmos with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset and no Analysis Services server bound. Power BI / Fabric / AAS are strictly opt-in alternatives that ALSO push the same TMSL to a live engine.
