# spark-environment — parity with Azure Synapse Spark pool "Packages + configuration" / Fabric Environment

Source UI:
- Azure Synapse Studio → Manage → Apache Spark pools → Packages (requirements + workspace packages + spark config) and the Scale dialog
- Fabric → Data Engineering → Environment (Runtime, Compute, Public/Custom libraries, Spark properties, Publish)
- Learn: https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-azure-portal-add-libraries

Backend is **100% Azure-native** — Synapse `Microsoft.Synapse/workspaces/bigDataPools` (ARM, api-version 2021-06-01) + ADLS Gen2 + Livy. No Microsoft Fabric capacity or workspace is required (`no-fabric-dependency.md`).

## Azure/Fabric feature inventory → Loom coverage

| Capability (source UI) | Loom coverage | Backend per control |
|---|---|---|
| Pick Spark runtime version (3.5 GA / 3.4) | ✅ Runtime tab dropdown + deprecation warning on 3.4 | baked to `properties.sparkVersion` on publish |
| Node family (MemoryOptimized / GPU) | ✅ Runtime tab dropdown | `properties.nodeSizeFamily` |
| Node size (Small…XXLarge) | ✅ Compute tab dropdown | `properties.nodeSize` |
| Autoscale (min/max) vs fixed node count | ✅ Compute tab switch + min/max or count | `properties.autoScale` / `properties.nodeCount` |
| Auto-pause (idle minutes ≥ 5) | ✅ Compute tab switch + delay | `properties.autoPause` |
| Session-level packages toggle | ✅ Compute tab switch | `properties.sessionLevelPackagesEnabled` |
| Public libraries — pip (requirements.txt) | ✅ Public libraries tab, pip format | `properties.libraryRequirements {content, filename: requirements.txt}` |
| Public libraries — conda (environment.yml) | ✅ Public libraries tab, conda format | `properties.libraryRequirements {content, filename: environment.yml}` |
| Custom libraries — upload .whl / .jar | ✅ Custom libraries tab upload → ADLS `landing/spark-env-libs/<id>/` | `POST /api/spark-environment/[id]/libraries` → ADLS `uploadFile`; referenced as `properties.customLibraries[]` |
| Custom libraries — list / delete | ✅ Table + delete | `DELETE …/libraries?name=` → ADLS `deletePath` |
| Spark properties (spark-defaults.conf) | ✅ Spark properties tab KeyValueGrid | `properties.sparkConfigProperties {content, filename: spark-defaults.conf}` |
| Publish (apply spec to pool) | ✅ Footer Publish button + provisioning status | `POST /api/spark-environment/[id]/publish` → ARM `getSparkPool` + `upsertSparkPool` (merge, never shrink) |
| Validate libraries importable | ✅ Validate import — live Livy session installs + imports, returns JSON receipt | `POST/GET /api/spark-environment/[id]/validate` → Livy session + statement |
| Attach to notebooks | ✅ Attach table — stamps `environmentId` + `preferredPool` on the notebook | `POST /api/spark-environment/[id]/attach` (Cosmos) |
| Attach to Spark job definitions | ✅ Attach table — stamps `environmentId` on the SJD | `POST /api/spark-environment/[id]/attach` (Cosmos) |
| Save spec | ✅ Ribbon Save + Ctrl+S | `PUT /api/items/spark-environment/[id]` (Cosmos) |

Zero ❌. The only non-functional states are honest infra gates (Fluent `MessageBar intent="warning"`):
- Custom-library upload when ADLS `landing` / UAMI role missing → names `LOOM_LANDING_URL` + the storage bicep module.
- Publish when the target Spark pool / `LOOM_SYNAPSE_WORKSPACE` missing → names the synapse bicep module.
- Managed-VNet / IL5 PyPI-blocked note on the Public libraries tab → directs to `.whl` upload or Managed Private Endpoints.

## Verify (operator)

1. Create a Spark environment, add `pandas==2.2.2` (Public libraries) and upload a `.whl` (Custom libraries).
2. Pick `loompool`, click **Publish** → receipt shows `provisioningState`.
3. Click **Validate import** → live Livy session installs + imports the package; the importable banner + JSON report is the receipt.
4. Attach the env to a notebook; run `import pandas` in a live cell on the published pool (ties to T17) → succeeds.

## Bicep sync

`platform/fiab/bicep/modules/landing-zone/synapse.bicep` — `loompool` now sets
`sessionLevelPackagesEnabled: true` so session-level pip/conda installs and
`Validate import` work without a first-publish race. No new resources, env vars,
or role grants (Console UAMI already has Synapse Administrator + RG Contributor;
Storage Blob Data Contributor on `landing` already granted for lakehouse upload).
