# sql-migration-assistant — parity with the Azure SQL → Synapse migration flow

Source UI:
- SQL Server Migration Assistant (SSMA) "Assess" + "Migrate schema" workflow
  and the Azure Synapse Pathway assessment report.
- DACPAC import: SSMS / sqlpackage "Import Data-tier Application".
  https://learn.microsoft.com/sql/tools/sql-database-projects/concepts/data-tier-applications/unpack-dacpac-file
- Dedicated SQL pool table surface area (the migration target):
  https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-tables-overview

The Loom "Warehouse" item is backed by an **Azure Synapse Dedicated SQL pool**
(the Azure-native default per `.claude/rules/no-fabric-dependency.md`). The
migration assistant lives as a **Migrate** tab on the Warehouse editor and needs
no Microsoft Fabric capacity or workspace to function.

## Azure / migration-tool feature inventory

| Capability (SSMA / sqlpackage / Synapse Pathway)                       | Where |
|------------------------------------------------------------------------|-------|
| Import a `.dacpac` data-tier application package                        | sqlpackage / SSMS |
| Read every object in the package model (tables, columns, types, PKs, indexes, views, procedures, functions, triggers) | DacFx model.xml |
| Compatibility assessment: flag constructs unsupported on the target    | SSMA Assess / Synapse Pathway |
| Map unsupported data types to a supported replacement                   | SSMA type mapping |
| Generate target-flavored DDL (distribution, columnstore, NOT ENFORCED PK) | Synapse Pathway |
| Apply the generated schema to the live target database                  | sqlpackage Publish |
| Selective import (schema-only first, then objects)                      | sqlpackage filters |
| Per-object success/failure report                                       | sqlpackage log |
| Download the generated migration script                                 | Pathway output |

## Loom coverage

| Inventory row                          | Status | Notes |
|----------------------------------------|--------|-------|
| Import a `.dacpac`                      | ✅ | Drag/drop or browse; multipart upload to `/migrate/scan`. |
| Read the package model                 | ✅ | `lib/azure/dacpac-model.ts` parses the modern DacFx `model.xml` (dependency-free, reuses `lib/azure/zip.ts` + `lib/azure/rdl-xml.ts`). |
| Compatibility assessment               | ✅ | `lib/azure/synapse-compat.ts#assessModel` — error/warning/info findings per object, grounded in the Dedicated-pool surface area. |
| Unsupported-type mapping               | ✅ | xml→nvarchar(max), spatial→varchar(max), sql_variant, text/ntext, timestamp/rowversion→binary(8), etc. |
| Generate Dedicated-pool DDL            | ✅ | `generateDdl` — `DISTRIBUTION = ROUND_ROBIN`, `CLUSTERED COLUMNSTORE INDEX`, `PRIMARY KEY NONCLUSTERED … NOT ENFORCED`, computed columns, schema creation. |
| Apply schema to the live pool          | ✅ | `/migrate/import` executes each statement over real TDS (`synapse-sql-client.executeQuery`). |
| Selective import by object kind        | ✅ | `kinds` checkboxes (schema/table/view/procedure/function). |
| Per-object result report               | ✅ | Each statement returns applied/failed + the real SQL error. |
| Download the generated script          | ✅ | "Download .sql" emits the full GO-separated script. |
| Honest gate when pool not configured / paused | ⚠️ | 409 with the exact env var / resume remediation surfaced as a Fluent MessageBar. |

Zero ❌. Triggers and bodyless objects are reported (excluded from import) with
remediation guidance, matching how SSMA flags non-portable constructs.

## Backend per control

| Control                       | Backend call |
|-------------------------------|--------------|
| Assess compatibility          | `POST /api/items/warehouse/migrate/scan` → `parseDacpac` + `assessModel` + `generateDdl` (read-only on the upload; no Azure call). |
| Import to warehouse           | `POST /api/items/warehouse/migrate/import` → `getPoolState` (ARM) gate, then `executeQuery` (TDS) per statement against the Dedicated SQL pool. |
| Download .sql                 | client-side blob of the server-generated script. |

## Infra / bicep

No new Azure resource, env var, or role assignment. The assistant reuses the
existing Warehouse backing:
- `LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_POOL` — already wired in
  `platform/fiab/bicep/modules/admin-plane/main.bicep`.
- The Console UAMI already holds Synapse Administrator on the workspace (the
  same grant the Warehouse query path uses).

## Verification

- `lib/azure/__tests__/dacpac-model.test.ts` — 19 tests covering name parsing,
  model parse (columns/types/nullability/identity/PK/computed/view/trigger),
  full ZIP parse + metadata + source compat level, type mapping, assessment
  findings, and Dedicated-pool DDL generation. All green.
- Scan is fully exercisable offline (no Azure dependency). Import requires the
  live pool Online; it surfaces an honest gate otherwise.
