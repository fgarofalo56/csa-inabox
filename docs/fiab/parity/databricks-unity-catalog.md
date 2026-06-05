# databricks-unity-catalog — parity with the Azure Databricks Catalog Explorer (Unity Catalog WRITE)

> Brutally-honest 1:1 parity audit (2026-06-01). Grading per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`. Graded
> conservatively; when in doubt, graded DOWN.
>
> Scope: the **Unity Catalog WRITE** surface recently deepened in the Databricks
> workspace studio — create catalog / schema / table (with a column designer)
> and grant/revoke privileges — all on the real UC REST. The broader Databricks
> workspace audit (navigator + clusters + jobs + notebooks + SQL + Repos) lives
> in `databricks-workspace.md`; this doc isolates the governance write surface,
> which that doc graded `F4–F8 ❌ MISSING` before this build wave.

**Source UI (grounded in Microsoft Learn, not memory):**
- Catalog Explorer — create first table + grant privileges: https://learn.microsoft.com/azure/databricks/getting-started/create-table
- Create catalogs (Catalog Explorer wizard: name, storage, workspace bindings, permissions, tags/comment): https://learn.microsoft.com/azure/databricks/catalogs/create-catalog
- Create schemas: https://learn.microsoft.com/azure/databricks/schemas/create-schema
- Tables concepts (MANAGED vs EXTERNAL, formats): https://learn.microsoft.com/azure/databricks/tables/tables-concepts
- Manage privileges in Unity Catalog (Catalog Explorer Permissions tab: Grant / Revoke; effective): https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/manage-privileges/
- Unity Catalog privileges reference (per-securable privilege matrix): https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/access-control/privileges-reference
- Create table from volumes / Catalog Explorer table-from-file dialog: https://learn.microsoft.com/azure/databricks/volumes/volume-files
- Data lineage in Unity Catalog: https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/databricks-editors.tsx` — `UnityCatalogWriteDialogs`
  (create catalog / schema / table dialogs + "Manage grants" dialog), mounted in
  `DatabricksSqlWarehouseEditor` (ribbon actions + toolbar buttons open the dialogs;
  the SQL-editor UC tree is the browse surface).
- BFF: `apps/fiab-console/app/api/databricks/unity-catalog/{catalogs,schemas,tables,grants}/route.ts`
- Client (real, AAD-token, no mocks): `apps/fiab-console/lib/azure/databricks-client.ts`
  — `listUcCatalogs/createUcCatalog/deleteUcCatalog`, `listUcSchemas/createUcSchema/deleteUcSchema`,
  `listUcTables/listUcVolumes/listUcFunctions/getUcTable/createUcTable/deleteUcTable`,
  `getUcPermissions/getUcEffectivePermissions/updateUcPermissions`.

**Backend reality check.** Every dialog hits the real Databricks Unity Catalog
REST (api 2.1): `GET/POST/DELETE /api/2.1/unity-catalog/{catalogs,schemas,tables}`,
`GET /volumes` + `/functions`, and `GET/PATCH
/api/2.1/unity-catalog/{permissions,effective-permissions}/{securable_type}/{full_name}`.
The console UAMI must hold `CREATE CATALOG` on the metastore (catalogs),
`CREATE SCHEMA`+`USE CATALOG` (schemas), `CREATE TABLE`+`USE SCHEMA`+`USE CATALOG`
(tables), and object ownership / `MANAGE` / metastore-admin (grants); a UC 403 is
surfaced verbatim. Honest 503 `not_configured` gate keyed on
`LOOM_DATABRICKS_HOSTNAME`. No `return []`, no `MOCK_`, no `useState(SAMPLE)`.

---

## Azure feature inventory → Loom coverage → backend

Legend: built ✅ (full 1:1 + real backend) · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Create catalog

| # | Catalog Explorer capability | Loom | Where / backend |
|---|---|---|---|
| A1 | Create catalog (name) | ✅ built | create-catalog dialog → `POST /catalogs` `createUcCatalog` |
| A2 | Optional storage root (managed-location override) | ✅ built | `storage_root` field → POST body |
| A3 | Comment | ✅ built | `comment` field → POST body |
| A4 | Drop catalog (with force) | ✅ built | `DELETE /catalogs?name=&force=` `deleteUcCatalog` |
| A5 | Catalog **type** (standard / foreign / shared / Delta-Sharing) | ❌ MISSING | standard only |
| A6 | Workspace-binding assignment (All / specific + Read-Only) | ❌ MISSING | wizard step absent |
| A7 | Tags (key-value) on the catalog | ❌ MISSING | not surfaced |
| A8 | Set owner | ❌ MISSING | creator-owned only |

### B. Create schema

| # | Catalog Explorer capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Create schema (name, parent catalog) | ✅ built | create-schema dialog → `POST /schemas` `createUcSchema` |
| B2 | Parent-catalog picker (defaults to active catalog) | ✅ built | dropdown seeded from `listUcCatalogs` |
| B3 | Optional storage root | ✅ built | `storage_root` → POST body |
| B4 | Comment | ✅ built | `comment` → POST body |
| B5 | Drop schema (full_name + force) | ✅ built | `DELETE /schemas?full_name=&force=` `deleteUcSchema` |
| B6 | Tags / owner on schema | ❌ MISSING | not surfaced |

### C. Create table (column designer)

| # | Catalog Explorer capability | Loom | Where / backend |
|---|---|---|---|
| C1 | Create table (catalog · schema · name) | ✅ built | create-table dialog → `POST /tables` `createUcTable` |
| C2 | MANAGED vs EXTERNAL | ✅ built | Type dropdown → `table_type` |
| C3 | Data-source **format** (DELTA/PARQUET/CSV/JSON/ORC/AVRO/TEXT) | ✅ built | Format dropdown → `data_source_format` |
| C4 | EXTERNAL **storage location** (abfss://) | ✅ built | conditional field (required for EXTERNAL) → `storage_location` |
| C5 | Per-column designer: add/remove rows | ✅ built | `addCol`/`delCol`; ≥1 column enforced |
| C6 | Per-column **name**, **type** (UC type list), **nullable**, **comment** | ✅ built | row inputs → `columns[]` `UcColumnSpec` |
| C7 | Table comment | ✅ built | Comment field → `comment` |
| C8 | Drop table | ✅ built | `DELETE /tables?full_name=` `deleteUcTable` |
| C9 | View table detail (columns) on select | ✅ built | `GET /tables?full_name=` `getUcTable` |
| C10 | Create table **from a file / volume** (upload → preview → infer schema) | ❌ MISSING | column designer only; no file-upload/inference dialog |
| C11 | Partition columns / clustering / table properties (`TBLPROPERTIES`) | ❌ MISSING | not surfaced |
| C12 | Column tags / masks / column-level comments-as-tags | ❌ MISSING | plain comment only |

### D. Volumes & functions

| # | Catalog Explorer capability | Loom | Where / backend |
|---|---|---|---|
| D1 | List volumes in a schema | ✅ built | `GET /tables` returns `volumes` (`listUcVolumes`, best-effort) |
| D2 | List functions in a schema | ✅ built | `GET /tables` returns `functions` (`listUcFunctions`, best-effort) |
| D3 | **Create** volume (managed/external) | ❌ MISSING | list-only |
| D4 | Browse / upload files in a volume | ❌ MISSING | not surfaced |
| D5 | Create / view function definition | ❌ MISSING | list-only |

### E. Manage grants (Permissions tab)

| # | Catalog Explorer capability | Loom | Where / backend |
|---|---|---|---|
| E1 | View direct grants on a securable | ✅ built | grants dialog "Load grants" → `GET /grants` `getUcPermissions` |
| E2 | View **effective** (inherited) grants | ✅ built | "effective" toggle → `getUcEffectivePermissions` |
| E3 | Securable picker (CATALOG/SCHEMA/TABLE/VOLUME/FUNCTION) | ✅ built | dropdown; drives the valid-privilege chip list |
| E4 | Grant privileges to a principal | ✅ built | privilege chips + "Grant selected" → `PATCH /grants` `add` |
| E5 | Revoke privileges from a principal | ✅ built | "Revoke selected" → `PATCH /grants` `remove` |
| E6 | Principal = user email / group / SP applicationId | ✅ built | free-text principal field (matches UC REST) |
| E7 | Per-securable privilege matrix (only valid privileges offered) | ✅ built | `UC_PRIVILEGES[securable]` chip set |
| E8 | EXTERNAL_LOCATION / STORAGE_CREDENTIAL / METASTORE securables | ⚠️ partial | BFF accepts them; dialog picker exposes only the 5 data securables |
| E9 | **Change owner** of a securable | ❌ MISSING | grant/revoke only; no ownership transfer |
| E10 | Principal **picker** (browse account users/groups) | ❌ MISSING | free-text only (no directory autocomplete) |

### F. Governance surfaces NOT in scope of this write build

| # | Catalog Explorer capability | Loom | Where / backend |
|---|---|---|---|
| F1 | Data **lineage** graph (upstream/downstream) | ❌ MISSING | no lineage UI |
| F2 | Sample data / column profile / table history | ❌ MISSING | not surfaced |
| F3 | Tags & comments browser across securables | ❌ MISSING | comment-on-create only |
| F4 | External locations / storage credentials / connections CRUD | ❌ MISSING | not surfaced |
| F5 | Delta Sharing (shares / recipients / providers) | ❌ MISSING | not surfaced |
| F6 | Workspace-catalog bindings management | ❌ MISSING | not surfaced |
| F7 | Insights / monitoring / quality (Lakehouse Monitoring) | ❌ MISSING | not surfaced |

---

## Coverage tally

- **built ✅: 24**
- **partial ⚠️: 1**
- **honest-gate ⚠️: 0** (the only gate is the workspace-level `not_configured` 503)
- **MISSING ❌: 17**

## Honest grade: **B−**

The create-catalog / create-schema / create-table-with-column-designer /
grant-revoke surface is genuinely **production-grade** and a real 1:1 with the
core Catalog Explorer write actions: every control issues a real UC 2.1 REST call,
the column designer matches the portal's per-column add/type/nullable/comment grid,
the grants dialog mirrors the Permissions tab's load → grant → revoke flow with a
correct per-securable privilege matrix and an effective-permissions toggle, and UC
403s surface verbatim. **No vaporware.** This flips the `databricks-workspace.md`
`F4–F5` rows (UC create + GRANT/REVOKE) from ❌ to ✅.

Held to **B−** (not A) by `ui-parity.md`'s "feature completeness must match"
applied to the whole Catalog Explorer write surface: no **create-table-from-file**
(the portal's most-used table-create path), no **volume/function create**, no
**lineage / sample-data / history**, no **external locations / storage credentials
/ connections / Delta Sharing**, no **ownership transfer**, no **workspace-binding**
or **tag** management, and the grant principal is free-text rather than a directory
picker.

## Highest-value gaps to build first

1. **Ownership transfer** (E9) — `updateUcPermissions` already exists; add an owner
   PATCH path. Cheapest governance completeness win.
2. **Create-table-from-file/volume** (C10) — the portal's primary table-create flow.
3. **Volume create + file browser** (D3–D4).
4. **Lineage graph** (F1) — the defining Catalog Explorer differentiator.
5. **Tags & comments browser** (A7/B6/C12/F3) across securables.
6. **External locations / storage credentials / connections / Delta Sharing** (F4–F5).

## Backend per control

| Control | BFF route | client fn | Databricks endpoint |
|---|---|---|---|
| List catalogs | `GET /api/databricks/unity-catalog/catalogs` | `listUcCatalogs` | `GET /api/2.1/unity-catalog/catalogs` |
| Create catalog | `POST …/catalogs` | `createUcCatalog` | `POST /api/2.1/unity-catalog/catalogs` |
| Drop catalog | `DELETE …/catalogs?name=&force=` | `deleteUcCatalog` | `DELETE /api/2.1/unity-catalog/catalogs/{name}` |
| List schemas | `GET …/schemas?catalog=` | `listUcSchemas` | `GET /api/2.1/unity-catalog/schemas` |
| Create schema | `POST …/schemas` | `createUcSchema` | `POST /api/2.1/unity-catalog/schemas` |
| Drop schema | `DELETE …/schemas?full_name=&force=` | `deleteUcSchema` | `DELETE /api/2.1/unity-catalog/schemas/{full_name}` |
| List tables/volumes/functions | `GET …/tables?catalog=&schema=` | `listUcTables`/`listUcVolumes`/`listUcFunctions` | `GET /api/2.1/unity-catalog/{tables,volumes,functions}` |
| Get table detail | `GET …/tables?full_name=` | `getUcTable` | `GET /api/2.1/unity-catalog/tables/{full_name}` |
| Create table | `POST …/tables` | `createUcTable` | `POST /api/2.1/unity-catalog/tables` |
| Drop table | `DELETE …/tables?full_name=` | `deleteUcTable` | `DELETE /api/2.1/unity-catalog/tables/{full_name}` |
| View grants | `GET …/grants?securable_type=&full_name=` | `getUcPermissions` | `GET /api/2.1/unity-catalog/permissions/{type}/{full_name}` |
| View effective grants | `GET …/grants?…&effective=true` | `getUcEffectivePermissions` | `GET /api/2.1/unity-catalog/effective-permissions/{type}/{full_name}` |
| Grant / revoke | `PATCH …/grants` | `updateUcPermissions` | `PATCH /api/2.1/unity-catalog/permissions/{type}/{full_name}` |

## Bicep / env sync

- Env var consumed: **`LOOM_DATABRICKS_HOSTNAME`** (shared with the rest of the
  Databricks surface — no new app-env entry).
- Roles: console UAMI needs metastore/securable privileges (`CREATE CATALOG`,
  `CREATE SCHEMA`, `CREATE TABLE`, object ownership / `MANAGE`); SCIM-bootstrapped per
  `platform/fiab/bicep/modules/landing-zone/databricks*.bicep`. A 403 renders the
  verbatim UC error.
- No new Azure resource or Cosmos container.

## Verification

- Mounted via `DatabricksSqlWarehouseEditor`; registered in `lib/editors/registry.ts`.
- Per `no-vaporware.md`: every create/drop/grant/revoke hits real UC 2.1 REST;
  honest 503 gate renders when `LOOM_DATABRICKS_HOSTNAME` unset.
- Live `pnpm uat` side-by-side against the Catalog Explorer write surface:
  **pending** (no minted session / reachable metastore in this worktree). The
  MISSING/partial rows were derived from code, not a live click-through, and should
  be confirmed against the live portal per the no-scaffold rule.
