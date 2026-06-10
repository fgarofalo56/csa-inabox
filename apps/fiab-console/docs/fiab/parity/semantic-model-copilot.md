# semantic-model-copilot — parity with Fabric "Copilot for semantic models" (model edits)

Source UI: Microsoft Fabric — Copilot in the semantic-model / Power BI Desktop
modeling experience (Build 2026 #26: "Copilot modifies semantic models").
Learn: https://learn.microsoft.com/power-bi/create-reports/copilot-introduction
and the TMSL command reference
(https://learn.microsoft.com/analysis-services/tmsl/rename-command-tmsl,
.../alter-command-tmsl).

The Fabric Copilot can change a model's STRUCTURE in natural language — rename
measures, add descriptions, propose relationships — and the modeling host keeps
an undo history. CSA Loom builds the same workflow over the Loom-native tabular
layer (Cosmos `item.state.model`) with an opt-in Azure Analysis Services XMLA
writeback. No Microsoft Fabric / Power BI workspace is required (per
`.claude/rules/no-fabric-dependency.md`).

## Fabric feature inventory (every capability)

| # | Capability | Notes |
|---|------------|-------|
| 1 | Rename a measure in NL ("rename these to clearer names") | Copilot proposes, user approves |
| 2 | Auto-generate measure descriptions | proposals, user approves |
| 3 | Suggest relationships between tables | fact→dimension joins on matching keys |
| 4 | Approve-before-write (nothing changes until accepted) | proposals are non-destructive |
| 5 | Undo / version history of model edits | restore a prior state |
| 6 | Push the change to the live model | engine rewrites references on rename |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | Rename measures (NL suggest → select → apply) | ✅ built | `model-structure-copilot.tsx` → `POST model-copilot {action:'suggest-renames' / 'apply-renames'}` → `renameMeasureInState` |
| 2 | Auto-describe measures (NL suggest → select → apply) | ✅ built | same pane → `suggest-descriptions` / `apply-descriptions` (parity with the prior DAX-Copilot `dax_describe_model` tool) |
| 3 | Suggest relationships | ✅ built | same pane → `suggest-relationships` / `apply-relationships` → `normalizeRelationship` + `upsertRelationship` |
| 4 | Approve-before-write | ✅ built | every `suggest-*` returns `pendingApproval:true`; the UI selects rows; only `apply-*` writes |
| 5 | Checkpoint + restore (undo history) | ✅ built | `checkpoint` / `restore-checkpoint` → `captureModelCheckpoint` / `restoreModelCheckpoint` (auto-checkpoint before every bulk apply; pre-restore checkpoint makes restore undoable; 20-deep ring) |
| 6 | Push to live model | ✅ built (opt-in) / ⚠️ honest-gate | applied renames/descriptions push a TMSL `rename` / `alter` to AAS via `executeAasXmla` when `LOOM_AAS_XMLA_ENDPOINT` is set; otherwise the Cosmos write is the source of truth and a "Loom-native (Cosmos)" badge discloses it |

Zero ❌. The only non-default state is the opt-in XMLA writeback, which is an
honest Azure infra disclosure (a badge), not a missing feature — the full
surface and all edits work without it.

## Backend per control

| Control | Backend |
|---------|---------|
| Suggest renames / descriptions / relationships | Azure OpenAI chat-completions (`lib/copilot/aoai-chat.ts`, UAMI-first, cloud-aware `cogScope`), grounded on the real model schema |
| Apply renames | Cosmos `item.state.model.measures[*].name` (`renameMeasureInState` + `writeModelState`); opt-in AAS XMLA `rename` |
| Apply descriptions | Cosmos `item.state.model.measures[*].description`; opt-in AAS XMLA `alter` |
| Apply relationships | Cosmos `item.state.model.relationships` (`upsertRelationship`); reflected in the model.bim TMSL preview |
| Checkpoint / restore | Cosmos `item.state.modelCheckpoints` (Azure-native snapshot ring) |

## Validation

- `app/api/items/_lib/__tests__/model-store.test.ts` — `renameMeasureInState`
  (rename, missing source, collision, invalid name, no-op).
- `lib/azure/__tests__/aas-tmsl-rename.test.ts` — `buildRenameMeasureTmsl` +
  `buildSetMeasureDescriptionTmsl` TMSL shape.
- Live E2E: minted-session probe of `GET/POST /api/items/semantic-model/<id>/model-copilot`
  with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — every action returns real data
  against the Loom-native Cosmos model (no Fabric).
