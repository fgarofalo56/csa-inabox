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
- BFF: `apps/fiab-console/app/api/databricks/unity-catalog/{catalogs,schemas,tables,grants,volumes,lineage,principals}/route.ts`
  (the `tables` route's `POST` accepts `mode:from_file` for C10; `principals` is the E10 SCIM picker)
- Client (real, AAD-token, no mocks): `apps/fiab-console/lib/azure/databricks-client.ts`
  — `listUcCatalogs/createUcCatalog/deleteUcCatalog/patchUcCatalog`, `listUcSchemas/createUcSchema/deleteUcSchema/patchUcSchema`,
  `listUcTables/listUcVolumes/listUcFunctions/getUcTable/createUcTable/deleteUcTable/patchUcTable`,
  `getUcPermissions/getUcEffectivePermissions/updateUcPermissions`.
- Tests: `apps/fiab-console/lib/azure/__tests__/databricks-uc-write-path.test.ts`
  (catalog type + tags + ownership PATCH REST contract).

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
| A5 | Catalog **type** (standard / foreign / Delta-Sharing) | ✅ built | "Type" dropdown → `catalog_type`; Foreign shows connection_name + options.database, Delta-Sharing shows provider_name + share_name → `createUcCatalog` |
| A6 | Workspace-binding assignment (All / specific + Read-Only) | ❌ MISSING | wizard step absent (multi-workspace metastore only) |
| A7 | Tags (key-value) on the catalog | ✅ built | inline `KvTagEditor` → `properties` map → `POST /catalogs` |
| A8 | Set owner | ✅ built | grants dialog "Change owner" → `PATCH /catalogs` `patchUcCatalog` (see E9) |

### B. Create schema

| # | Catalog Explorer capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Create schema (name, parent catalog) | ✅ built | create-schema dialog → `POST /schemas` `createUcSchema` |
| B2 | Parent-catalog picker (defaults to active catalog) | ✅ built | dropdown seeded from `listUcCatalogs` |
| B3 | Optional storage root | ✅ built | `storage_root` → POST body |
| B4 | Comment | ✅ built | `comment` → POST body |
| B5 | Drop schema (full_name + force) | ✅ built | `DELETE /schemas?full_name=&force=` `deleteUcSchema` |
| B6 | Tags / owner on schema | ✅ built | tags via `KvTagEditor` → `properties` on `POST /schemas`; owner via grants dialog "Change owner" → `PATCH /schemas` `patchUcSchema` |

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
| C10 | Create table **from a file / volume** (upload → infer schema) | ✅ built | Create-table dialog "From file" tab: browser reads the file → POST `tables` `mode:from_file` → `createUcTableFromFile` uploads to a UC volume (`PUT /api/2.0/fs/files`) then `CREATE TABLE … AS SELECT * FROM read_files(…)` on the warehouse (schema inferred) |
| C11 | Partition columns / clustering / table properties (`TBLPROPERTIES`) | ❌ MISSING | not surfaced |
| C12 | Column tags / masks / column-level comments-as-tags | ❌ MISSING | plain comment only |

### D. Volumes & functions

| # | Catalog Explorer capability | Loom | Where / backend |
|---|---|---|---|
| D1 | List volumes in a schema | ✅ built | `GET /tables` returns `volumes` (`listUcVolumes`, best-effort) |
| D2 | List functions in a schema | ✅ built | `GET /tables` returns `functions` (`listUcFunctions`, best-effort) |
| D3 | **Create** volume (managed/external) | ✅ built | create-volume dialog → `POST /api/2.1/unity-catalog/volumes` `createUcVolume` (MANAGED/EXTERNAL; storage_location for EXTERNAL) |
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
| E8 | EXTERNAL_LOCATION / STORAGE_CREDENTIAL / METASTORE securables | ✅ built | grants securable dropdown now offers all 8 types with per-securable privilege matrices (`UC_PRIVILEGES`); BFF `/grants` accepts them → `GET/PATCH /api/2.1/unity-catalog/permissions/{type}/{full_name}` |
| E9 | **Change owner** of a securable | ✅ built | grants dialog "Change owner" section (CATALOG/SCHEMA/TABLE) → `PATCH /{catalogs,schemas,tables}` `patchUc{Catalog,Schema,Table}` with `{ owner }` (UC `ALTER … SET OWNER`) |
| E10 | Principal **picker** (browse account users/groups) | ✅ built | grants "Principal" is a freeform `Combobox` autocompleting over `GET /api/databricks/unity-catalog/principals?q=` → `listUcPrincipals` → SCIM `GET /api/2.0/preview/scim/v2/{Users,Groups,ServicePrincipals}`; freeform fallback + honest warning when SCIM is unavailable |

### F. Governance surfaces NOT in scope of this write build

| # | Catalog Explorer capability | Loom | Where / backend |
|---|---|---|---|
| F1 | Data **lineage** graph (upstream/downstream) | ✅ built | `UcLineagePanel` (lineage tab + per-table button) → `GET /api/databricks/unity-catalog/lineage` → `getTableLineage` (`/api/2.0/lineage-tracking/table-lineage`) + `getTableLineageSystemTables` (`system.access.{table,column}_lineage`) |
| F2 | Sample data / column profile / table history | ❌ MISSING | not surfaced |
| F3 | Tags & comments browser across securables | ❌ MISSING | comment-on-create only |
| F4 | External locations / storage credentials / connections CRUD | ❌ MISSING | not surfaced |
| F5 | Delta Sharing (shares / recipients / providers) | ❌ MISSING | not surfaced |
| F6 | Workspace-catalog bindings management | ❌ MISSING | not surfaced |
| F7 | Insights / monitoring / quality (Lakehouse Monitoring) | ❌ MISSING | not surfaced |

---

## Coverage tally

- **built ✅: 37** (was 29; the **audit-t18 final wave** added C10 create-table-from-file,
  E10 principal directory picker, E8 storage/metastore securables, and reconciled
  two rows that were already shipped but mis-graded — F1 lineage graph and D3
  volume create)
- **partial ⚠️: 0** (E8 promoted to built)
- **honest-gate ⚠️: 0** (the only gate is the workspace-level `not_configured` 503)
- **MISSING ❌: 11** (was 12 → 17 baseline): A6, C11, C12, D4, D5, F2, F3, F4, F5, F6, F7

## Honest grade: **B+**

The create-catalog / create-schema / create-table-with-column-designer /
grant-revoke surface is genuinely **production-grade** and a real 1:1 with the
core Catalog Explorer write actions: every control issues a real UC 2.1 REST call,
the column designer matches the portal's per-column add/type/nullable/comment grid,
the grants dialog mirrors the Permissions tab's load → grant → revoke flow with a
correct per-securable privilege matrix and an effective-permissions toggle, and UC
403s surface verbatim. **No vaporware.** This flips the `databricks-workspace.md`
`F4–F5` rows (UC create + GRANT/REVOKE) from ❌ to ✅.

The **audit-t18 final wave** closed the top three highest-value gaps from the
prior "build next" list and reconciled two rows that were already shipped:

- **Create-table-from-file (C10)** — the portal's most-used table-create path.
  The Create-table dialog gains a "From file" tab: the browser reads the file,
  POSTs it to the `tables` route with `mode:from_file`, and `createUcTableFromFile`
  uploads it to a UC volume (`PUT /api/2.0/fs/files`) then runs
  `CREATE TABLE … AS SELECT * FROM read_files(…)` on the bound warehouse so the
  schema is **inferred** — exactly the portal flow. Honest warning when no
  warehouse is bound or the schema has no staging volume.
- **Principal directory picker (E10)** — the grant "Principal" field is now a
  freeform `Combobox` autocompleting over workspace SCIM
  (`/api/databricks/unity-catalog/principals` → `listUcPrincipals` →
  `/api/2.0/preview/scim/v2/{Users,Groups,ServicePrincipals}`). Freeform fallback
  + an honest warning when SCIM is unavailable, so a principal can always be typed.
- **Storage / metastore securables (E8 → built)** — the grants securable picker
  now offers EXTERNAL_LOCATION / STORAGE_CREDENTIAL / METASTORE with their correct
  privilege matrices (the BFF already accepted them).
- **Reconcile (no-vaporware honesty):** F1 lineage graph and D3 volume create were
  already shipped in earlier audit-t18 commits but were still graded ❌ — flipped
  to ✅ against the code.

Held to **B+** (not A) by `ui-parity.md`'s "feature completeness must match"
applied to the whole Catalog Explorer write surface: still no **column-level
tags / masks** (C12), no **partition/clustering/TBLPROPERTIES** (C11), no
**volume file browser** (D4) or **function create** (D5), no **sample-data /
profile / history** (F2), no cross-securable **tag/comment browser** (F3), no
**external locations / storage credentials / connections / Delta-Sharing CRUD**
(F4–F5), no **workspace-binding** management (A6/F6), and no **Lakehouse
Monitoring** (F7).

## Highest-value gaps to build next

1. **External locations / storage credentials / connections / Delta Sharing CRUD** (F4–F5).
2. **Volume file browser** (D4) + **function create/view** (D5).
3. **Column-level tags / masks** (C12) + a cross-securable tag/comment browser (F3).
4. **Sample data / column profile / table history** (F2).
5. **Partition / clustering / TBLPROPERTIES** (C11) on create-table.
6. **Workspace-catalog bindings** (A6/F6) — multi-workspace metastore only.
7. **Lakehouse Monitoring** (F7).

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
| Create table from file (C10) | `POST …/tables` (`mode:from_file`) | `createUcTableFromFile` | `PUT /api/2.0/fs/files/{vol path}` + `POST /api/2.0/sql/statements` (read_files CTAS) |
| Create volume (D3) | `POST …/volumes` | `createUcVolume` | `POST /api/2.1/unity-catalog/volumes` |
| Principal directory picker (E10) | `GET …/principals?q=` | `listUcPrincipals` | `GET /api/2.0/preview/scim/v2/{Users,Groups,ServicePrincipals}` |
| Lineage graph (F1) | `GET …/lineage` | `getTableLineage` / `getTableLineageSystemTables` | `POST /api/2.0/lineage-tracking/table-lineage` + `system.access.{table,column}_lineage` |
| Drop table | `DELETE …/tables?full_name=` | `deleteUcTable` | `DELETE /api/2.1/unity-catalog/tables/{full_name}` |
| View grants | `GET …/grants?securable_type=&full_name=` | `getUcPermissions` | `GET /api/2.1/unity-catalog/permissions/{type}/{full_name}` |
| View effective grants | `GET …/grants?…&effective=true` | `getUcEffectivePermissions` | `GET /api/2.1/unity-catalog/effective-permissions/{type}/{full_name}` |
| Grant / revoke | `PATCH …/grants` | `updateUcPermissions` | `PATCH /api/2.1/unity-catalog/permissions/{type}/{full_name}` |
| Create foreign / Delta-Sharing catalog | `POST …/catalogs` (catalog_type) | `createUcCatalog` | `POST /api/2.1/unity-catalog/catalogs` |
| Catalog / schema tags | `POST …/{catalogs,schemas}` (properties) | `createUcCatalog`/`createUcSchema` | `POST /api/2.1/unity-catalog/{catalogs,schemas}` |
| Change catalog owner / comment | `PATCH …/catalogs` | `patchUcCatalog` | `PATCH /api/2.1/unity-catalog/catalogs/{name}` |
| Change schema owner / comment | `PATCH …/schemas` | `patchUcSchema` | `PATCH /api/2.1/unity-catalog/schemas/{full_name}` |
| Change table owner / comment | `PATCH …/tables` | `patchUcTable` | `PATCH /api/2.1/unity-catalog/tables/{full_name}` |

## Bicep / env sync

- Env var consumed: **`LOOM_DATABRICKS_HOSTNAME`** (shared with the rest of the
  Databricks surface — no new app-env entry).
- **Unity Catalog is configured by DEFAULT (2026-06).** The deploy now creates +
  assigns the regional UC metastore, creates a default catalog, and grants the
  Console UAMI `account_admin`, so **Browse > Unity Catalog shows a real
  configured metastore/catalog after a stock deploy** — no manual account-console
  clicking. Two synced enablement paths share the same logic
  (`scripts/csa-loom/enable-unity-catalog.sh`):
  - **Bicep (`az deployment ... -p commercial.bicepparam`):**
    `platform/fiab/bicep/modules/landing-zone/databricks-uc-bootstrap.bicep` runs a
    `deploymentScripts@2023-08-01` (AzureCLI) as the Console UAMI. Wired in
    `landing-zone/main.bicep` (section 3b) `if (ucSupported && !empty(databricksAccountId)
    && !empty(databricksUcScriptUamiId) && !empty(consoleUamiAppId))`. Inputs:
    `databricksAccountId` (typed param, surfaced in `params/{commercial,commercial-full,gcc}.bicepparam`),
    `workspaceNumericId` / `workspaceHost` (new `databricks.bicep` outputs), and
    `adminPlane.outputs.uamiConsoleId` as the script identity.
  - **Post-deploy workflow (repair / re-run):**
    `.github/workflows/csa-loom-post-deploy-bootstrap.yml` step *"Enable Unity
    Catalog (metastore + default catalog + UAMI account-admin)"* runs the same
    script with `--workspace-host "$DBX_HOST"` (public access is temporarily
    enabled in that job) so the default catalog is created + pinned.
  - **One-time human requirement (honest gate per `no-vaporware.md`):** the script
    identity (Console UAMI for the bicep path, deploy SP for the workflow path) must
    be a **Databricks account admin** — granted once via the account console. When
    absent, the script logs a warning and the deploy continues (UC enablement is
    never a hard blocker); the Browse UC group shows an actionable empty-state.
  - **Boundary matrix:** Commercial + GCC enable UC by default (`ucSupported`).
    GCC-High / IL5 use the Hive metastore — the UC-bootstrap module is skipped.
- Roles: console UAMI needs metastore/securable privileges (`CREATE CATALOG`,
  `CREATE SCHEMA`, `CREATE TABLE`, object ownership / `MANAGE`); SCIM-bootstrapped per
  `platform/fiab/bicep/modules/landing-zone/databricks*.bicep`. A 403 renders the
  verbatim UC error.
- **C10 create-table-from-file** needs `WRITE VOLUME` on the staging volume plus a
  running SQL Warehouse (the same warehouse the editor already binds) to run the
  `read_files` CTAS — both are UC-runtime privileges / existing resources, no new
  Azure resource or app-env entry. **E10 principal picker** needs workspace **SCIM
  read** (the console UAMI is already a workspace member via the UC bootstrap); a
  SCIM 403 surfaces an honest "directory unavailable — type the principal directly"
  warning and the freeform Combobox still works. No new env var, role, or Cosmos
  container is introduced by this wave.
- **Ownership transfer (E9)** uses the same UC privilege model as grants —
  current-owner / metastore-admin / `MANAGE` on the object. No new Azure resource,
  role assignment, or app-env entry; it is a UC-runtime privilege, surfaced
  verbatim as a 403 if absent. **Foreign catalogs** need `CREATE FOREIGN CATALOG`
  on the connection and **Delta-Sharing catalogs** need `USE PROVIDER` — both are
  UC privileges, not Azure roles, and 403 verbatim when missing.
- No new Cosmos container. The only new Azure resource is the one-shot UC-bootstrap
  `deploymentScript` (auto-cleaned on success).


## Verification

- Mounted via `DatabricksSqlWarehouseEditor`; registered in `lib/editors/registry.ts`.
- Per `no-vaporware.md`: every create/drop/grant/revoke hits real UC 2.1 REST;
  honest 503 gate renders when `LOOM_DATABRICKS_HOSTNAME` unset.
- Live `pnpm uat` side-by-side against the Catalog Explorer write surface:
  **pending** (no minted session / reachable metastore in this worktree). The
  MISSING/partial rows were derived from code, not a live click-through, and should
  be confirmed against the live portal per the no-scaffold rule.
