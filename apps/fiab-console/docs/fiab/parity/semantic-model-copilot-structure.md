# semantic-model-copilot-structure — parity with Power BI / Fabric Copilot "edit model" + Tabular Editor structure edits

Source UI:
- Power BI / Fabric Copilot in the semantic-model web modeling view (rename measures, write descriptions, suggest relationships): https://learn.microsoft.com/power-bi/create-reports/copilot-introduction
- Tabular Editor / TMSL Alter for model structure (the engine path the edits compile to): https://learn.microsoft.com/analysis-services/tmsl/alter-command-tmsl

## Azure/Fabric feature inventory (every capability)

| # | Capability (Fabric/Power BI Copilot + modeling view) | Backend |
|---|------------------------------------------------------|---------|
| 1 | Describe a change in natural language; Copilot proposes a concrete edit | Copilot LLM |
| 2 | Rename a measure | TMSL Alter (measure rename) |
| 3 | Add / edit a measure's description (business glossary) | TMSL Alter (measure.description) |
| 4 | Add / edit a table description | TMSL Alter (table.description) |
| 5 | Suggest relationships between fact/dimension tables | model relationships |
| 6 | Review before apply (human-in-the-loop, no surprise writes) | client UX |
| 7 | Undo / restore a prior model structure (version safety net) | TMSL deploy of a saved model / Git integration |

## Loom coverage

| # | Loom coverage | Notes |
|---|---------------|-------|
| 1 | ✅ Built — "Copilot (structure)" tab → `POST {action:'propose'}` → Azure OpenAI returns a structured edit plan grounded in the real model schema | Honest gate (⚠️) when no AOAI deployment is configured (MessageBar names `LOOM_AOAI_ENDPOINT`/`LOOM_AOAI_DEPLOYMENT` + the UAMI role) |
| 2 | ✅ Built — rename-measure op; Azure-native write to the Loom model store + best-effort TMSL Alter mirror | |
| 3 | ✅ Built — set-measure-description op (complements the existing DAX auto-describe, which only *proposes* descriptions) | |
| 4 | ✅ Builder present (`buildSetTableDescriptionTmsl`) for the XMLA mirror path | table descriptions live on the live model; Loom store keys on measures/relationships |
| 5 | ✅ Built — suggest-relationship op persisted Loom-native (Cosmos relationships) | |
| 6 | ✅ Built — propose returns `pendingApproval`; nothing writes until `{action:'apply', plan}` | |
| 7 | ✅ Built — a checkpoint is captured before every apply; `Restore` rolls back; restore is itself reversible (auto pre-restore snapshot). Manual "Save checkpoint now" too | |

Zero ❌, zero stub banners.

## Backend per control

- **Propose** → `POST /api/items/semantic-model/[id]/copilot-structure {action:'propose'}` → Azure OpenAI chat (`resolveAoaiTarget`, cloud-portable, UAMI token) → structured `{summary, ops[]}` re-validated against the real model.
- **Apply** → `{action:'apply', plan}` → (1) `captureCheckpoint` (Cosmos `item.state.modelCheckpoints`), (2) `writeModelState` (Cosmos `item.state.model` — the Azure-native DEFAULT), (3) best-effort `executeXmlaCommand(buildRenameMeasureTmsl | buildSetMeasureDescriptionTmsl)` ONLY when `aasXmlaConfig()` resolves (opt-in XMLA; failure never drops the Cosmos write).
- **Checkpoints / Restore** → `GET ?action=checkpoints`, `POST {action:'restore', checkpointId}`, `POST {action:'checkpoint'}` → `_lib/semantic-model-checkpoints.ts` over Cosmos `items`.

## No-fabric-dependency

The full surface (propose, apply, checkpoint, restore) works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET and no XMLA endpoint: the source of truth is the Loom-native Cosmos model store, and the structure edits are emitted into the model.bim at provision time. The XMLA mirror is opt-in (`LOOM_AAS_SERVER_URL` — Azure Analysis Services, no Microsoft Fabric / Power BI workspace required). No `api.powerbi.com` / `api.fabric.microsoft.com` on the default path.

## Bicep / env sync

No new Azure resource, Cosmos container, or env var. Reuses:
- `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` (Copilot — already wired in admin-plane bicep).
- `LOOM_AAS_SERVER_URL` / `LOOM_AAS_DATABASE` (opt-in XMLA mirror — already wired by `analysis-services.bicep`).
- Cosmos `items` container (existing) for both `item.state.model` and `item.state.modelCheckpoints`.
