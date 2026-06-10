# warehouse-migration-assistant — parity with Fabric Migration Assistant for Data Warehouse

Source UI:
- Microsoft Fabric → Data Warehouse → **Migration Assistant** (Build 2026 #22)
  (https://learn.microsoft.com/fabric/data-warehouse/migration-assistant)
- SqlPackage `/Action:Publish` of a `.dacpac` to a Synapse Dedicated SQL pool, with a
  pre-publish compatibility assessment
  (https://learn.microsoft.com/sql/tools/sqlpackage/sqlpackage-for-azure-synapse-analytics)
- Synapse dedicated SQL pool feature gaps
  (https://learn.microsoft.com/azure/synapse-analytics/sql/develop-tables-overview#unsupported-table-features,
   /azure/synapse-analytics/sql/overview-features)

This surface is the **Migrate** tab inside the Warehouse editor (`warehouse`,
Azure-native default = Synapse Dedicated SQL pool), also reachable from the
ribbon **Manage → Migration assistant** action.

## Azure/Fabric feature inventory

| # | Capability (real UI) | Notes |
|---|----------------------|-------|
| 1 | Upload a source schema artifact | Fabric Migration Assistant points at the source DW; SqlPackage consumes a `.dacpac` |
| 2 | Connect/identify source | DACPAC `DacMetadata.xml` carries name + version |
| 3 | Object inventory | tables / views / procedures / functions / constraints discovered in the source |
| 4 | Compatibility assessment | flag features unsupported by the target (FK, computed/sparse cols, triggers, sequences, unsupported types, indexed views) |
| 5 | Remediation guidance per finding | each issue has an explicit fix |
| 6 | Generated migration script / preview | review the DDL before applying |
| 7 | Choose distribution / index for tables | dedicated-pool tables need DISTRIBUTION + index (Fabric Warehouse hides this; Synapse exposes it) |
| 8 | Apply / import to the target | execute the schema against the live warehouse |
| 9 | Per-object import results | success/failure for each created object |
| 10 | Idempotent re-run | skip objects that already exist |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `MigrationAssistantTab` drag-drop / file-picker for `.dacpac` (≤ 50 MiB) → multipart POST |
| 2 | built ✅ | `parseDacpac` reads `DacMetadata.xml`; the assessment header shows source name + version |
| 3 | built ✅ | `parseDacpac` enumerates every `<Element Type="Sql…">` → per-type count badges |
| 4 | built ✅ | `scanCompatibility` graded findings (block/warn/info) vs the documented dedicated-pool restriction set |
| 5 | built ✅ | each `CompatFinding.remediation` rendered in the findings table (with "(auto)" when auto-remediated) |
| 6 | built ✅ | `generateDeployScript` DDL shown in the preview `<pre>`; skipped-objects MessageBar |
| 7 | built ✅ | distribution Dropdown (ROUND_ROBIN/HASH/REPLICATE) + index Dropdown (CCI/HEAP) |
| 8 | built ✅ | "Import schema" → POST action=deploy → `deployToSynapse` over TDS to the live pool |
| 9 | built ✅ | import-results table: per-statement Created / error |
| 10 | built ✅ | "Idempotent" Switch → `ifNotExists` → `IF OBJECT_ID(...) IS NULL` guards |
| — | honest-gate ⚠️ | missing `LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL` → 503 MessageBar naming the env vars; paused pool → 409 with resume instruction. Assess still works without a pool bound. |

Zero ❌. Zero stub banners. Assessment + generated DDL are real; import returns the
live per-object TDS receipt.

## Backend per control

| Control | Backend |
|---------|---------|
| Pool badge / gate | `GET /api/items/warehouse/[id]/migrate` → `getPoolState()` (ARM) + bound env vars |
| Assess compatibility | `POST …/migrate` action=scan → `parseDacpacWithBodies` (in-process PKZIP via `lib/azure/zip.ts`) + `scanCompatibility` + `generateDeployScript` (read-only) |
| Generated DDL preview | same scan response (`preview.script`, `preview.skipped`) |
| Import schema | `POST …/migrate` action=deploy → `deployToSynapse(gen, dedicatedTarget())` → TDS `executeQuery` per statement on the live Synapse dedicated pool |

## No-Fabric / no-vaporware compliance

- The only backend is the Synapse Dedicated SQL pool over the existing TDS path
  (`synapse-sql-client`). No `api.fabric.microsoft.com` / `api.powerbi.com`.
  Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- DACPAC parsing is done in-process (no `sqlpackage.exe`, no external service) by
  reading the model XML — no mock arrays, no `return []`. An unreadable / non-DACPAC
  upload returns a descriptive 422.
- Pure parse/scan/generate logic is unit-tested:
  `lib/azure/__tests__/dacpac-migrate.test.ts` (7 tests) builds a real zipped DACPAC
  in-process and asserts FK/trigger/sequence/computed/geometry are flagged, types are
  remapped, and the generated DDL carries DISTRIBUTION + index.

## Bicep sync

No new Azure resources, env vars, role assignments, or Cosmos containers. The
feature reuses the existing dedicated pool (`LOOM_SYNAPSE_WORKSPACE`,
`LOOM_SYNAPSE_DEDICATED_POOL`, already wired in
`platform/fiab/bicep/modules/admin-plane/main.bicep`) and the existing UAMI Synapse
SQL admin grant (DDL execute). Nothing to add — no drift.

## Verification

- `npx tsc --noEmit` → 0 errors in the touched files (`dacpac-migrate.ts`,
  `migration-assistant-tab.tsx`, `migrate/route.ts`, `phase3-editors.tsx` edits).
- `vitest run lib/azure/__tests__/dacpac-migrate.test.ts` → 7 passed.
- Live receipt (pool bound): `POST /api/items/warehouse/<id>/migrate` (multipart,
  file=<.dacpac>, action=scan) returns `{ ok, metadata, counts, report, preview }`;
  action=deploy returns `{ ok, deploy:{ executed, failed, results[] } }` from real TDS.
