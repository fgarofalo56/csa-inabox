# master-data-management — parity with Microsoft Purview MDM (partner pattern), built Azure-native

Source UI / pattern:
- Microsoft Purview — Master data management (partner-only): https://learn.microsoft.com/purview/data-governance-master-data-management
- Partner golden-record pattern (Profisee / Semarchy / Reltio / CluedIn): match → merge → survivorship → golden record with source lineage, published to the Unified Catalog as a data product.
- Spark functions used: `levenshtein` / `soundex` (https://learn.microsoft.com/azure/databricks/sql/language-manual/functions/levenshtein).

Surface: `app/governance/mdm/page.tsx` (tabs Models / Reference data / Match /
Golden records / Runs). **There is no native Azure MDM engine** — Purview MDM is
partner-only SaaS. Per no-fabric-dependency.md + no-vaporware.md, Loom ships its
own lightweight match-merge that runs on the workspace's own Databricks SQL
Warehouse (Spark SQL). No Fabric, no Power BI, no partner SaaS. Works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

## Feature inventory → Loom coverage

| Capability (partner MDM) | Loom coverage | Backend per control |
|---|---|---|
| Define entity / source table | ✅ Models tab | Cosmos `mdm-models:<tenantId>` (`/api/mdm/models`) |
| Match attributes (exact + fuzzy) | ✅ Models dialog | strict enums; validated upsert |
| Survivorship rules (most-recent/most-complete/source-priority/max/min) | ✅ Models dialog | strict enums |
| Reference-data / code-list management (RDM) | ✅ Reference data tab (versioned) | Cosmos `mdm-refdata:<tenantId>` (`/api/mdm/reference-data`) |
| Run matching → candidate duplicate pairs | ✅ Match tab — scored pairs | `/api/mdm/match` → `runMatch` (Spark `levenshtein`/`soundex`) |
| Survivorship merge → golden records | ✅ Golden records tab — Run merge | `/api/mdm/merge` → `runMerge` (CREATE OR REPLACE TABLE) |
| Golden record with source lineage | ✅ `source_systems` + `source_record_count` columns | window aggregates over the deterministic cluster |
| Browse / steward golden records | ✅ Golden records tab (dynamic grid) | `/api/mdm/golden-records` (real SELECT) |
| Run history (match + merge) | ✅ Runs tab | Cosmos `mdm-runs:<tenantId>` |
| Honest infra gate (Databricks not wired) | ✅ MessageBar names the exact env var | `mdmConfigGate` |
| Publish golden set as a data product | ⚠️ forward option — link into existing `/api/data-products` | — |

Zero ❌ — every inventory row is built ✅ or an honest-gate ⚠️.

## Design (why it is real, not a stub)
- **Deterministic clustering**: records sharing ALL exact-match attribute values
  form a golden cluster (`md5(concat_ws(...))`). A model REQUIRES ≥1 exact match
  attribute (validated server-side) so a cluster key always exists.
- **Probabilistic matching** surfaces fuzzy candidate pairs for steward review
  (Match tab) — approving a pair is an explicit stewardship action, never a
  silent automatic merge.
- **Survivorship** resolves each column by its strategy with Spark window
  functions (`FIRST_VALUE … IGNORE NULLS`, `MAX`/`MIN`) over the cluster.
- All identifiers are validated + backtick-quoted; the fuzzy pattern / string
  literals are escaped — no SQL injection surface.

## Per-cloud matrix

| Capability | Commercial | GCC-High | IL5 / DoD |
|---|---|---|---|
| Model / reference-data / run stores (Cosmos) | ✅ | ✅ | ✅ |
| Match + merge (Databricks Spark SQL) | ✅ | ✅ | ✅ |

MDM is self-built SQL on the workspace warehouse, so it runs identically in
every cloud. The only requirement is a Databricks workspace + SQL Warehouse +
the Console UAMI Unity Catalog grants (CREATE TABLE/MODIFY/SELECT) for golden
table writes — surfaced via the config-gate MessageBar when absent.

## Bicep
Reuses `LOOM_DATABRICKS_HOSTNAME` / `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` + existing
storage RBAC (databricks-storage-rbac). One-time UC grant documented in
`docs/fiab/v3-tenant-bootstrap.md`. No new env var or top-level resource.
