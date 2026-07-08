# dataset — parity with Azure AI Foundry / Azure ML data asset

Source UI: Microsoft Foundry portal → Data (data assets) and Azure ML studio →
Data (https://ai.azure.com/data)
(https://learn.microsoft.com/azure/machine-learning/how-to-create-data-assets,
https://learn.microsoft.com/azure/machine-learning/concept-data).

> Note: this Loom item is the **Foundry / Azure ML data asset** (URI file, URI
> folder, MLTable — the versioned dataset consumed by prompt flows, evaluations,
> and training runs), *not* the Power BI/Fabric semantic dataset. The catalog
> entry is `Foundry dataset` (restType `FoundryDataset`).

Azure-native backend (no Fabric): **Azure ML / Foundry data assets** via the
Foundry data-plane REST (`foundry-client` `listDataAssets` / `createDataAsset` /
`getDataAsset`), with **Synapse Serverless OPENROWSET** for the live data +
schema preview and an AML-job scan for lineage. No Fabric/Power BI workspace.

## Foundry / AML data-asset inventory (grounded in Learn)

1. **Register a data asset** — name, type (`uri_file`, `uri_folder`,
   `mltable`), URI (`azureml://` or `abfss://`), version, description.
2. **Scope** — hub-level or per Foundry project.
3. **Versions** — every registration bumps a version; list + compare versions.
4. **Browse / pick a path** from ADLS storage.
5. **Preview data + schema profile** — sample rows + per-column profile.
6. **Lineage** — which jobs produced / consumed the asset.
7. **Data quality / drift** — via an AML Data Drift monitor.

## Loom coverage

| AML / Foundry data-asset capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **List data assets** (hub or project scope, type filter) | ✅ built — list with scope + type dropdowns | `GET /api/items/dataset?project=` → `listDataAssets` |
| **Register asset** (name, type, URI, version, description) | ✅ built — New asset form (uri_file/uri_folder/mltable) | `POST /api/items/dataset` → `createDataAsset` |
| **Browse ADLS** to pick a URI | ✅ built — `AdlsBrowseDialog` "Browse…" → sets URI + inferred type | `/api/items/dataset/browse` (ADLS listing) |
| **Versions** tab (list) | ✅ built — Versions tab, per-version type/URI/created | `GET /api/items/dataset/[id]` (asset + versions) |
| **Version diff** (A vs B, URI/type change) | ✅ built — Diff A / Diff B dropdowns + change summary | client over versions |
| **Data & schema preview** (sample rows + column profile: count/null/distinct/min/max/mean/stddev) | ✅ built — `DatasetPreviewPanel` | `GET /api/items/dataset/[id]/preview` → ARM (asset) + Synapse Serverless OPENROWSET |
| **Lineage** (producers / consumers from AML jobs) | ✅ built — Lineage tab, producer/consumer badges + jobsScanned | `GET /api/items/dataset/[id]/lineage` (AML job scan) |
| Deep-link to Foundry data surface | ✅ built — ribbon → `ai.azure.com/projects/{p}/data` or `/data` | n/a |
| **Data quality / drift** | ⚠️ honest-gate — Quality & drift tab MessageBar: needs an AML Data Drift monitor + `LOOM_DRIFT_MONITOR`; Data & schema tab already profiles the active version live | n/a |
| Foundry hub / AML workspace not deployed, or non-ADLS URI, or non-tabular file | ⚠️ honest-gate — preview returns honest 503 (Serverless unconfigured) / 422 (non-ADLS) / metadata-only (non-tabular); `ErrorBar` names the remediation | n/a |

Zero ❌. The preview/profile is computed from real sampled rows via Synapse
Serverless — no mock rows (per `no-vaporware.md`).

## Backend per control

- List / create: `/api/items/dataset` (GET/POST) → `foundry-client.{listDataAssets,createDataAsset}`.
- Detail (asset + versions): `GET /api/items/dataset/[id]?project=`.
- ADLS browse: `/api/items/dataset/browse`.
- Preview + schema profile: `GET /api/items/dataset/[id]/preview?project=&version=&top=` → ARM getDataAsset + `synapse-sql-client` OPENROWSET over the parsed `abfss/https` ADLS path.
- Lineage: `GET /api/items/dataset/[id]/lineage` (scans AML jobs for input/output URI references).
- Drift: honest-gate on `LOOM_DRIFT_MONITOR` (AML Data Drift monitor).
