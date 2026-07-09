# semantic-link — parity with Microsoft Fabric Semantic Link (SemPy)

Source UI / API: https://learn.microsoft.com/fabric/data-science/semantic-link-overview
(`sempy.fabric`), plus semantic-link-validate-relationship and
semantic-link-service-principal-support.

CSA Loom item: `semantic-model` (notebook-importable helper `loom_semantic_link`,
BFF `/api/items/semantic-model/[id]/semantic-link`). FGC-17.

## Fabric SemPy feature inventory

| SemPy capability | What it does |
|---|---|
| `fabric.list_datasets()` | List semantic models |
| `fabric.list_tables(dataset)` | List a model's tables + columns |
| `fabric.list_measures(dataset)` | List a model's measures (name, table, DAX) |
| `fabric.list_relationships(dataset)` | List relationships |
| `fabric.evaluate_measure(dataset, measure, groupby)` | Evaluate a measure, optionally grouped |
| `fabric.evaluate_dax(dataset, dax)` | Run an EVALUATE query → DataFrame |
| `FabricDataFrame.add_measure(...)` | Pull a measure into a DataFrame column |
| `FabricDataFrame` semantic lineage | DataFrame remembers its dataset |
| `validate_relationships(...)` | Flag broken/missing relationships |
| SP support | Auth via managed identity / SP |

## Loom coverage

| Row | Loom | Backend |
|---|---|---|
| list datasets | ✅ `list_tables`/`list_measures` per model (owner-scoped) | `GET /semantic-link` → tabular-eval-client |
| list tables / measures | ✅ | `listTables` / `listMeasures` (Cosmos metadata / AAS) |
| list relationships | ✅ `list_relationships()` | `readModelState` (state.model.relationships) |
| evaluate_dax | ✅ | `POST {op:'evaluate-dax'}` → `evalDax` (Synapse SQL / AAS XMLA) |
| evaluate_measure / add_measure | ✅ ungrouped (loom-native) + grouped ⚠️ (AAS-only, honest error) | `POST {op:'add-measure'}` → `buildMeasureEvalDax` |
| FabricDataFrame lineage | ✅ `LoomDataFrame` carries `_loom_model_id` | pandas subclass |
| validate_relationships | ✅ same analyzer as the model-health scan | `POST {op:'validate-relationships'}` → `analyzeRelationships` |
| SP / identity | ✅ minted session token (LOOM_SESSION_TOKEN) — no separate SP flow | BFF session |

**No `api.powerbi.com` / `api.fabric.microsoft.com` on any path.** Grouped
measure evaluation is the one honest gate: it needs the opt-in AAS backend
(`LOOM_SEMANTIC_BACKEND=analysis-services`); the loom-native Synapse translator
returns an honest "unsupported pattern" error rather than a fake result.

## Delivery

- Injected as a notebook Livy/AML session preamble (default-on; opt out with
  `LOOM_SEMANTIC_LINK=0`) — `LoomDataFrame` etc. are available with no pip install.
- Shipped on the AML compute-instance PYTHONPATH via the curated `loom-pylsp-env`
  AML Environment (`platform/fiab/bicep/modules/deploy-planner/ml-workspace.bicep`).

Usage: see `docs/fiab/notebook/semantic-link.md`.
