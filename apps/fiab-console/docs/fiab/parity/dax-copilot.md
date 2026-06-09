# dax-copilot — parity with Power BI / Fabric Copilot for DAX (Loom-native)

Source UI: Power BI Desktop "Copilot" DAX pane + Fabric "Copilot for Power BI" measure
authoring (NL2DAX, explain, optimize) — https://learn.microsoft.com/power-bi/create-reports/copilot-introduction
and DAX query view with Copilot — https://learn.microsoft.com/dax/dax-copilot

Loom surface: `SemanticModelEditor` → **Measures (DAX)** tab → **DAX Copilot** pane.
Backend persona: `dax` (`lib/azure/copilot-personas.ts`). Route: `POST /api/copilot/dax`.
Tools: `lib/copilot/dax-tools.ts` (`dax_*`). Evaluation: Azure Synapse Dedicated SQL pool.

> **No Power BI / Fabric on the default path.** Every DAX Copilot capability runs
> against the Loom-native tabular layer (model metadata in Cosmos `item.state.model`,
> evaluation via Synapse T-SQL). Zero `api.powerbi.com` / `api.fabric.microsoft.com`
> calls — verified by grep gate. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

## Power BI / Fabric Copilot-for-DAX feature inventory

| # | Capability (source UI)                                   | What it does |
|---|----------------------------------------------------------|--------------|
| 1 | NL → DAX measure                                         | Type "create a YoY revenue measure" → get a DAX expression grounded on the model |
| 2 | Validate / evaluate the generated measure                | Confirm the expression runs and returns a value before saving |
| 3 | Explain DAX                                              | Plain-language explanation of an expression, step by step |
| 4 | Optimize / improve DAX                                   | Rewrite for performance / best practice (DIVIDE, SUMMARIZECOLUMNS, VAR…) |
| 5 | Auto-generate measure descriptions (metadata)           | Write business-friendly descriptions for measures |
| 6 | Persist descriptions to the model                        | Save approved descriptions into the model metadata |
| 7 | Insert the generated measure into the editor             | One-click apply into the DAX editor |
| 8 | Ground answers in the real model schema                  | Use actual table/column/measure names, not hallucinated |

## Loom coverage

| # | Capability | Status | Loom implementation |
|---|------------|--------|---------------------|
| 1 | NL → DAX measure | ✅ built | `dax_nl2measure` → AOAI grounded on `buildSchemaContext(model)`; returns `{daxExpression, evaluation, confidence}` |
| 2 | Validate / evaluate | ✅ built | `buildTSqlProbe` → `executeQuery(dedicatedTarget(), …)` on Synapse; simple aggregates fully evaluated, complex (time-intelligence) get an honest structural check with `confidence:'unvalidated'` |
| 3 | Explain DAX | ✅ built | `dax_explain` → AOAI plain-language step breakdown |
| 4 | Optimize DAX | ✅ built | `dax_optimize` → AOAI rewrite + change notes; optimized expression auto-inserts into the editor |
| 5 | Auto-generate descriptions | ✅ built | `dax_describe_model` → AOAI proposals (read-only; pending approval) |
| 6 | Persist descriptions | ✅ built | `dax_save_descriptions` → `writeModelState` to Cosmos `item.state.model.measures[*].description` |
| 7 | Insert generated measure | ✅ built | UI auto-sets `daxExpr` from the `dax_nl2measure` / `dax_optimize` tool_result step |
| 8 | Ground in real schema | ✅ built | `dax_model_context` reads `readModelState(item)` first; system prompt forbids inventing names |

Zero ❌. The only honest limitation (full DAX-engine semantic evaluation of
time-intelligence) is disclosed in-product as `confidence:'unvalidated'` with the
reason — not a silent gap. A real DAX/XMLA engine (Azure Analysis Services) is the
documented opt-in for full evaluation; it is **not required** for the surface to work.

## Backend per control

| Control | Backend |
|---------|---------|
| Ask box → `dax_nl2measure` | AOAI chat (`resolveAoaiTarget` + `cogScope`) for generation; Synapse Dedicated TDS for the validation probe |
| `dax_explain` / `dax_optimize` | AOAI chat only (no data plane) |
| `dax_describe_model` | AOAI chat (proposals) |
| `dax_save_descriptions` | Cosmos `items` container (`writeModelState`) |
| `dax_eval_probe` | Synapse Dedicated SQL pool (`executeQuery`) |
| AOAI token | `ChainedTokenCredential(ManagedIdentity{LOOM_UAMI_CLIENT_ID}, Default)` → `cogScope()` (`cognitiveservices.azure.us` in Gov) |
| Synapse token | `synapse-sql-client` UAMI chain → `getSqlSuffix()` SQL audience (cloud-portable) |

## Cloud matrix

| | Commercial | GCC | GCC-High / IL5 | DoD |
|---|---|---|---|---|
| AOAI scope (`cogScope`) | `cognitiveservices.azure.com` | same | `cognitiveservices.azure.us` | `cognitiveservices.azure.us` |
| Synapse SQL suffix | `sql.azuresynapse.net` | same | `sql.azuresynapse.usgovcloudapi.net` | same as GCC-High |
| Cosmos items | `*.documents.azure.com` | same | `*.documents.azure.us` | same as GCC-High |
| `api.powerbi.com` calls | 0 | 0 | 0 | 0 |

All routing is automatic via `detectLoomCloud()` / `isGovCloud()` — no hardcoded
Commercial endpoints in `dax-tools.ts`.

## Env / infra (all pre-existing — no new resource)

- `LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT` — AOAI chat target (admin-plane bicep).
- `LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL` — Synapse pool for evaluation.
- `LOOM_UAMI_CLIENT_ID` — Console UAMI used for both AOAI and Synapse tokens.
- Cosmos `items` container — already created by `cosmos-client`.

No new bicep module, env var, role assignment, or Cosmos container is required: the
DAX Copilot reuses the cross-item Copilot's AOAI wiring and the semantic-model
editor's existing Synapse + Cosmos backends.

## Verification

- Unit: `lib/copilot/__tests__/dax-tools.test.ts` (`buildTSqlProbe` translation + injection-safe fallback).
- Grep gate: `grep -rn "api.powerbi.com\|api.fabric.microsoft.com\|powerbi-client" lib/copilot/dax-tools.ts app/api/copilot/dax` → 0 hits.
- E2E (operator): open a Loom-native semantic-model item with measures, ask
  "create a YoY revenue measure" → valid DAX inserts into the editor + a Synapse
  probe runs; "describe the measures" → proposals → approve → descriptions persist
  to Cosmos. Receipt attached to the PR.
