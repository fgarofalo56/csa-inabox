# model-health-scan — parity with Power BI Copilot "modify semantic model"

Source: https://learn.microsoft.com/power-bi/create-reports/copilot-modify-semantic-model
(Power BI 2026 wave — "Copilot can now modify semantic models") + Best Practice
Analyzer rules.

CSA Loom surface: the **Model health** tab in the semantic-model editor
(`lib/editors/components/model-health-pane.tsx`), BFF
`/api/items/semantic-model/[id]/model-health`. FGC-22.

## Feature inventory

| Capability | What it does |
|---|---|
| Detect model issues | Ambiguous/missing relationships, no marked date table, unused columns, DAX anti-patterns, measure errors |
| Propose fixes | Copilot suggests concrete edits |
| Review + apply | A diff/preview the user approves before the model is modified |
| Reversible | Undo / restore after apply |

## Loom coverage

| Row | Loom | Backend |
|---|---|---|
| detect issues | ✅ `analyzeModelHealth` rule set (broken/missing/ambiguous relationships, unmarked date table, measure-no-description, non-additive measure anti-pattern, unused columns) | pure analyzer over Cosmos model + table content |
| propose fixes | ✅ per-finding fix ops; AOAI generates measure descriptions | `POST {action:'scan'}` → analyzer + `aoaiChat` |
| review + apply | ✅ select fixes, apply with a checkpoint captured first | `POST {action:'apply'}` → `captureCheckpoint` + `writeModelState` |
| reversible | ✅ checkpoints list + restore | `restoreCheckpoint` (same plumbing as the NL-structure Copilot) |

**No `api.powerbi.com` / `api.fabric.microsoft.com` on any path.** The scan works
with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset and no AAS server bound. When Azure
OpenAI is not configured the scan still returns every rule-based finding and
surfaces an honest gate for the description-generation step only.
