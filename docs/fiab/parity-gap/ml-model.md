# ml-model — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/ml-model/new`
**Fabric reference**: ai.azure.com → Models (registered model with versions, tags, lineage, deployments, sample inputs, evaluation cards)
**Loom screenshot**: `temp/parity/ml-model-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/ml-model` (list) | 200 | 0 models |
| `GET /api/items/ml-model/new` | **404** | `{"ok":false,"error":"not found"}` — Loom UI renders "Load failed — not found" MessageBar |

Same pattern as ml-experiment: `/new` doesn't make sense for read-only model registry.

## Phase 3 — Fabric vs Loom

| Fabric element | Loom present? | Severity |
|---|---|---|
| Versions left tree | YES — but empty | — |
| Version detail (URI / type / created / tags / properties) | YES — flat table | — |
| **Schema** (inputs/outputs with type + shape) | NO | MAJOR |
| **Sample inferencing** widget (paste JSON → POST to endpoint) | NO | MAJOR |
| **Lineage** (training run that produced the model + dataset assets) | NO | MAJOR |
| **Evaluation scorecards** (eval runs tied to this model version) | NO | MAJOR |
| **Deploy** wizard (online endpoint / batch endpoint) | partial — "Real-time endpoint" ribbon button visible but dead | MAJOR |
| **Apply (PREDICT)** ribbon — dead button | dead | MAJOR (Fabric T-SQL `PREDICT` integration is a real feature) |
| **Compare versions** ribbon — dead button | dead | MAJOR |
| Tags / properties edit | NO — read only | MINOR |

## Functional

- /new crashes with "Load failed — not found"
- 3 ribbon actions ("Compare versions", "Apply (PREDICT)", "Real-time endpoint") are all dead

## Grade — **F**

`/new` is broken (read-only registry can't have /new). Three vaporware ribbon buttons. **Grade F.**

Recommendation: same as ml-experiment — should be a list view, not a create flow.
