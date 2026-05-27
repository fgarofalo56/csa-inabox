# copilot-studio-topic — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/copilot-studio-topic/new`
**Fabric reference**: copilotstudio.microsoft.com — Topic authoring (visual node graph: Trigger → Question → Message → Condition → Action → Power Fx; trigger-phrase picker; tester pane)
**Loom screenshot**: `temp/parity/copilot-studio-topic-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/copilot-studio-topic?envId=<env>&agentId=...` | 503 | Same Copilot-Studio-not-enabled honest gate |

UI renders Topic name input · Trigger phrases textarea (one-per-line) · Flow YAML textarea · Save button. Pre-fills YAML stub: `kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Hello"`.

## Phase 3 — Fabric vs Loom

| Copilot Studio element | Loom present? | Severity |
|---|---|---|
| **Visual node graph editor** (drag nodes, connect with arrows, type-ahead node palette) | **NO — Loom has a `<textarea>` for raw YAML** | **BLOCKER** |
| **Node inspector pane** (per-node config: variables, conditions, slot-filling rules) | NO | BLOCKER |
| **Variables / slots panel** | NO | MAJOR |
| **Power Fx expression editor** | NO | MAJOR |
| **Test bot side-pane** (chat with topic in isolation) | NO | BLOCKER |
| **Trigger phrase NLP confidence score** | NO | MAJOR |
| **Adaptive Card preview** | NO | MAJOR |
| **Monaco for YAML** with adaptive-dialog schema validation | NO — plain `<textarea>`, no syntax highlighting or schema | MAJOR (BLOCKER per build-phase contract #1) |
| Trigger phrases list | YES (multi-line textarea, parsed line-by-line) | — |
| Honest 503 MessageBar | YES | — |

## Functional

- Save fires real Dataverse upsert (when env permits) — verified route exists
- YAML editor accepts free text — no validation

## Grade — **F**

Topics are the soul of Copilot Studio. Replacing the visual graph editor with a YAML textarea is essentially "BYO YAML and good luck". Plus no test pane, no Power Fx editor, no Adaptive Card preview, no Monaco. **Grade F.**
