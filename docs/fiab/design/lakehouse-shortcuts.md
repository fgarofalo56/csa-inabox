# Lakehouse "Shortcuts" — Azure-native, NO Fabric dependency

> **Status:** Design. **Author:** CSA Loom engineering. **Scope:** `apps/fiab-console` Lakehouse editor "Shortcuts" tab + supporting BFF + bicep.
>
> **One-line goal:** Replicate Microsoft Fabric **OneLake shortcuts** (a named pointer that virtualizes external data into a Lakehouse without copying bytes) for tenants that do **not** have Fabric, using only Azure-native back-services (ADLS Gen2, Databricks Unity Catalog, Synapse Serverless SQL, Cosmos DB).

---

## 0. Problem statement (the vaporware/Fabric-dependency violation we are fixing)

The current Lakehouse editor's **Shortcuts** tab (`apps/fiab-console/lib/editors/lakehouse-editor.tsx`, tab `shortcuts`, lines ~209–301 and ~1023–1373) is wired to the **real Microsoft Fabric OneLake Shortcuts REST API**:

- It POSTs to `/api/catalog/shortcut` (`apps/fiab-console/app/api/catalog/shortcut/route.ts`), which calls `createOneLakeShortcut` / `listOneLakeShortcuts` / `deleteOneLakeShortcut` in `apps/fiab-console/lib/azure/fabric-client.ts`.
- Those functions hit `https://api.fabric.microsoft.com/v1/workspaces/{ws}/items/{lakehouse}/shortcuts` with the `https://api.fabric.microsoft.com/.default` scope.
- The UI forces the operator to supply a **Fabric workspace GUID + Fabric Lakehouse item GUID** (persisted in `localStorage` as `loom.lakehouse.fabricBinding.<id>`) and a **Fabric cloud-connection GUID** ("Create in Fabric → Manage connections").

**This is a hard Fabric dependency.** For a Loom tenant with no Fabric capacity, every control on this tab is dead: the "New shortcut" button is disabled until you paste a Fabric workspace/item id that does not exist, and even with ids it would 401/403 against `api.fabric.microsoft.com`. This violates `ui-parity.md` (the surface should reproduce the *capability*, not bind to the source product) and `no-vaporware.md` (looks real, can't work without Fabric).

**The fix:** replace the Fabric-binding shortcuts implementation with a Loom-native shortcut engine backed by ADLS Gen2 + Databricks Unity Catalog external tables/locations + Synapse Serverless external tables, with the shortcut definitions persisted in a Cosmos registry. The Fabric path can remain as an *optional* internal-OneLake target only when `LOOM_FABRIC_BASE`/Fabric binding is present, but it is never required.

---

## 1. Fabric OneLake shortcuts — feature inventory (grounded in Microsoft Learn)

Sources: `learn.microsoft.com/fabric/onelake/onelake-shortcuts`, `/fabric/data-engineering/lakehouse-shortcuts`, `/fabric/onelake/create-adls-shortcut`, `/rest/api/fabric/articles/item-management/definitions/lakehouse-definition#shortcut`, `/rest/api/fabric/core/onelake-shortcuts/list-shortcuts`.

### 1.1 What a shortcut is
A shortcut is an **embedded reference (metadata pointer)** that points at data in external storage or another Fabric item. It provides **zero-copy** access: the referenced data appears as a local folder (under `Files`) or table (under `Tables`) in the lakehouse namespace and is read transparently at query time via the same ADLS Gen2 REST surface as native OneLake data. No ETL, no migration.

### 1.2 Supported source ("target") types
| Type | Notes |
| --- | --- |
| **Internal OneLake** | Another Fabric Lakehouse / Warehouse / KQL DB / Mirrored DB / SQL DB / Semantic model, same or cross-workspace/tenant. Authorizes with the **calling user's identity**. |
| **ADLS Gen2** | Target = DFS endpoint `https://<acct>.dfs.core.windows.net` + container/sub-path. Requires HNS enabled. |
| **Azure Blob Storage** | Blob endpoint variant of ADLS. |
| **Amazon S3** | `https://<bucket>.s3.<region>.amazonaws.com` + sub-path. |
| **S3-compatible** | MinIO/Cloudflare/etc with endpoint + bucket. |
| **Google Cloud Storage** | GCS bucket endpoint + sub-path. |
| **Dataverse** | Dataverse environment URL + table. |
| **OneDrive/SharePoint**, **Iceberg**, **on-prem (OPDG gateway)** | Additional sources. |

### 1.3 Creation model (REST + UX)
- **REST:** `POST /v1/workspaces/{ws}/items/{lakehouse}/shortcuts` with body `{ name, path, target }`, where `path` is a string beginning with `Files` or `Tables`, and `target` carries **exactly one** of `{ adlsGen2 | azureBlobStorage | amazonS3 | googleCloudStorage | s3Compatible | dataverse | oneLake | oneDriveSharePoint }` plus a `type` enum. External targets carry `{ location, subpath, connectionId }`; `connectionId` is a **Fabric cloud connection** that stores the credential.
- **Credentials (external):** delegated auth via a cloud connection — Organizational account, Service principal, Workspace identity, SAS, or Account key. ADLS requires Storage Blob Data Reader/Contributor/Owner (or Delegator) on the storage account.
- **UX:** Lakehouse Explorer → right-click `Tables` or `Files` (or any sub-folder) → **New shortcut** → **New table shortcut / New schema shortcut / New shortcut** → pick **Internal sources** or **External sources** → choose type → connection settings (URL + connection + auth kind + credentials) → **Next** → browse the source tree and tick target folder(s) → **Next** review (rename/delete each) → **Create**. The shortcut then appears in the Explorer with a chain/link badge.
- **Placement rules:** `Tables` shortcuts must be top-level; if the target holds Delta data it auto-registers as a table queryable from Spark **and** the SQL analytics endpoint. `Files` shortcuts can be at any depth and are not auto-registered as tables.
- **List/manage:** `GET .../shortcuts` returns each shortcut's `path`, `name`, `target.type`, and target details. Definitions also persist in git as `shortcuts.metadata.json`. External-target shortcuts support **caching** (1–28 day retention) for cross-cloud egress savings.

---

## 2. Azure-native mapping — how Loom virtualizes each capability (no Fabric)

**Core idea:** Loom's lakehouse "OneLake" is the **ADLS Gen2 medallion account** (`bronze`/`silver`/`gold`/`landing` containers, already wired via `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL` in `lib/azure/adls-client.ts`). A Loom shortcut is a **registry row** (Cosmos) plus, depending on placement and engine, a **read-through object** created in a query engine:

| Fabric concept | Loom Azure-native equivalent | Backend call |
| --- | --- | --- |
| OneLake namespace / lakehouse storage | ADLS Gen2 medallion containers | `@azure/storage-file-datalake` (existing `adls-client.ts`) |
| Shortcut metadata pointer | **Cosmos `lakehouse-shortcuts` container** row | `cosmos-client.ts` `createIfNotExists` |
| `Tables` shortcut (Delta auto-registers, SQL-queryable) over ADLS/S3/GCS | **Databricks Unity Catalog external location + external table**: `CREATE EXTERNAL LOCATION ... URL 'abfss://...' WITH (STORAGE CREDENTIAL ...)` then `CREATE TABLE cat.sch.tbl LOCATION 'abfss://.../dir'` (Delta/Parquet) | `databricks-client.ts` `executeStatement` over a SQL Warehouse |
| `Tables`/`Files` shortcut queryable from T-SQL without Databricks | **Synapse Serverless external table / view**: `CREATE EXTERNAL DATA SOURCE` (+ optional `DATABASE/SERVER SCOPED CREDENTIAL`) and `CREATE EXTERNAL TABLE` or a `CREATE VIEW ... OPENROWSET(...)` | `synapse-sql-client.ts` `executeQuery(serverlessTarget())` |
| `Files` shortcut (raw, any format, Spark-readable) | Registry row only; resolved at read time to `abfss://`/`s3a://`/`gs://` for Spark notebooks (the editor already prefills Spark `spark.read.format(...).load("abfss://...")`) | registry resolve, no DDL needed |
| Internal OneLake shortcut (another Loom lakehouse) | Registry row pointing at another Loom lakehouse's container/path → resolves to the same `abfss://` account | registry resolve |
| External cloud connection (stored credential) | **Loom connection**: UAMI passthrough (default), or SAS/access-key/SP secret stored in **Key Vault**, referenced by `credentialRef` | UC `STORAGE CREDENTIAL` / Synapse `SCOPED CREDENTIAL` / Spark conf |
| Shortcut caching | (Phase 2) optional — out of scope for v1; Databricks/Synapse read live | n/a v1 |

### 2.1 Storage addressing + credentials per source type
| Source | Read URI scheme | Default credential (no extra infra) | Alt credentials |
| --- | --- | --- | --- |
| **ADLS Gen2 / Blob** | `abfss://<container>@<acct>.dfs.core.windows.net/<path>` | **Console UAMI** (`LOOM_UAMI_CLIENT_ID`) with Storage Blob Data Reader on the target account → UC storage credential / Synapse Managed-Identity credential | SAS, account key, SP (KV-stored) |
| **Amazon S3** | `s3://<bucket>/<path>` (UC) / `s3a://` (Spark) | none — requires AWS keys or IAM role (KV `credentialRef`) | IAM role ARN (UC storage credential) |
| **GCS** | `gs://<bucket>/<path>` | none — requires GCS service-account JSON (KV `credentialRef`) | UC GCP service account |
| **S3-compatible** | endpoint + bucket via Spark conf | access key/secret (KV) | — |
| **Dataverse** | Synapse Link export ADLS path (`abfss://...`) | UAMI on the Synapse Link storage | — |
| **Internal Loom lakehouse** | `abfss://` to the source container | UAMI | — |

**Design decision:** v1 ships **ADLS Gen2 (incl. Blob) + Internal Loom lakehouse** as fully UAMI-backed (zero extra credential infra), and **S3 / GCS / S3-compatible / Dataverse** as **honest-gated** source types: the full create wizard renders, but if no `credentialRef` (Key Vault secret) is configured the Create button shows a Fluent `MessageBar intent="warning"` naming the exact KV secret / role required. This satisfies `no-vaporware.md`'s honest-config-only state rule.

### 2.2 Read-through resolution (how a query engine "reads through" a shortcut)
1. Engine/notebook asks "what is shortcut `X` under `Tables/`?"
2. BFF resolves the Cosmos registry row → `{ targetType, targetUri, credentialRef, engineObject }`.
3. For a **Tables** shortcut, `engineObject` is the fully-qualified UC table (`loom.<lakehouse>.<name>`) or the Synapse external table (`[shortcuts].[<name>]`) created at shortcut-creation time. The user queries it by name; the engine reads the external bytes live.
4. For a **Files** shortcut, the BFF returns the `abfss://`/`s3a://` URI + format so the Notebook/Spark editor loads it directly.

---

## 3. Data model — Cosmos `lakehouse-shortcuts` container

Add to `lib/azure/cosmos-client.ts` `ensure()` via the existing `mk()` helper:

```ts
_lakehouseShortcuts = await mk('lakehouse-shortcuts', '/lakehouseId');
```

Document shape:

```ts
interface LakehouseShortcut {
  id: string;                 // `${lakehouseId}:${section}:${parentPath}:${name}` (deterministic, dedupes)
  lakehouseId: string;        // partition key — the Loom lakehouse (== container or item id)
  tenantId: string;           // for tenant isolation in queries
  name: string;               // shortcut display name (leaf shown in Explorer)
  section: 'Files' | 'Tables';
  parentPath: string;         // sub-folder under the section, '' for top-level
  fullPath: string;           // `${section}/${parentPath}/${name}` — Explorer path
  targetType: 'adls' | 'blob' | 's3' | 'gcs' | 's3compat' | 'dataverse' | 'internal';
  targetUri: string;          // abfss://… | s3://… | gs://… | internal lakehouse ref
  // resolved read addresses for each engine (filled at create)
  abfssUri?: string;          // for Spark / UC / Synapse
  credentialRef?: {           // null/undefined => UAMI passthrough
    kind: 'uami' | 'sas' | 'accountKey' | 'servicePrincipal' | 'awsKeys' | 'gcsServiceAccount';
    keyVaultSecret?: string;  // KV secret name holding the secret payload
    storageCredentialName?: string; // UC STORAGE CREDENTIAL name, if pre-provisioned
  };
  engine?: 'databricks' | 'synapse' | 'none'; // which engine backs Tables reads
  engineObject?: string;      // e.g. 'loom.bronze.partner_products' or 'shortcuts.partner_products'
  format?: 'delta' | 'parquet' | 'csv' | 'json'; // for Tables registration
  status: 'active' | 'pending' | 'error';
  statusDetail?: string;      // last engine error if status=error
  createdBy: string;          // upn
  createdAt: string;          // ISO
  updatedAt: string;
}
```

Notes:
- The registry is the **source of truth** for the Explorer; engine objects (UC/Synapse) are derived and idempotently re-creatable from a row (supports teardown/redeploy per `no-vaporware.md`).
- `id` is deterministic so re-creating the same shortcut is an upsert, mirroring Fabric's "a shortcut at a path is unique."

---

## 4. UX spec — 1:1 with Fabric, Loom theme

All in `lakehouse-editor.tsx`, replacing the Fabric-binding block. **Remove** `scWorkspaceId`/`scItemId`/`localStorage` Fabric binding, the "Bind a Fabric lakehouse" MessageBar, and the `connectionId` GUID field.

### 4.1 Entry points (match Fabric Explorer)
- **Right-click** a folder/section node in the left file tree or the Files table → context menu **New shortcut…** (the menu item already exists at line ~1251 — re-point it to the new dialog, and pre-fill `section`+`parentPath` from the right-clicked node).
- **Shortcuts tab** toolbar: **New shortcut** button (always enabled when a container is selected — no Fabric binding gate) + **Refresh**.
- A **Tables** node context offers **New table shortcut** and **New schema shortcut** (schema = folder of Delta tables) to mirror Fabric's two Tables options.

### 4.2 New shortcut wizard (Fluent Dialog, 3 steps mirroring Fabric)
1. **Step 1 — Source type picker.** Card/radio grid: **Internal sources** → *Loom lakehouse*; **External sources** → *ADLS Gen2, Azure Blob, Amazon S3, Google Cloud Storage, S3-compatible, Dataverse*. Each external card shows a Badge: "UAMI-ready" (ADLS/Blob/internal) or "Needs credential" (S3/GCS/etc).
2. **Step 2 — Connection + location.**
   - ADLS/Blob: **Account URL** (`https://<acct>.dfs.core.windows.net`), **Sub-path** (`/container/folder`), **Auth kind** dropdown (Workspace UAMI [default] / SAS / Account key / Service principal). For non-UAMI, a **Key Vault secret name** field (`credentialRef.keyVaultSecret`).
   - S3/GCS/S3-compat: endpoint/bucket + sub-path + **required** credential (KV secret) — if missing, inline `MessageBar warning` with the exact env/secret to set.
   - Internal: source **lakehouse dropdown** (lists Loom lakehouses) + source path.
   - A **Browse** affordance (Phase 1.5): for ADLS/internal, call a "list target" route to tree-browse and tick folders (Fabric parity); v1 may accept a typed sub-path with a "Test connection" button that does a real `listPaths` HEAD.
3. **Step 3 — Name + placement + review.** **Section** (Files/Tables), **Subfolder**, **Shortcut name**, **Format** (Tables only: Delta/Parquet/CSV/JSON). Review table of what will be created (name, path, target, engine object). **Create**.

### 4.3 Shortcuts list (replaces current table)
Columns: **Name**, **Path**, **Source type** (badge), **Engine** (Databricks/Synapse/—), **Status** (active/pending/error chip with detail tooltip), **Actions** (Open → switches to Files/Tables tab at the path or opens a notebook prefilled to read it; Test → re-runs the engine read; Delete). Empty state: "No shortcuts yet. Click **New shortcut** to virtualize ADLS Gen2 / S3 / GCS / another Loom lakehouse without copying data." Every button calls a real route. Status chips reflect real engine state from the registry.

### 4.4 Explorer integration
Shortcut rows render in the **Files**/**Tables** trees with a **link/chain icon** overlay (Fabric parity) so a shortcut is visually distinct from a native folder. Clicking a Tables shortcut prefills the SQL tab with `SELECT TOP 100 * FROM <engineObject>`; clicking a Files shortcut prefills the Spark "Open in notebook" path with the resolved `abfss://` URI.

---

## 5. BFF routes (real Azure calls per control)

New namespace `app/api/items/lakehouse/[id]/shortcuts/` (the lakehouse owns its shortcuts — no `/catalog/shortcut` Fabric route). Standard envelope `{ ok, data?, error?, code?, hint? }`. All `getSession()`-gated, `runtime='nodejs'`, `force-dynamic`.

| Route | Method | Backend |
| --- | --- | --- |
| `/api/items/lakehouse/[id]/shortcuts` | **GET** | Cosmos query `SELECT * FROM c WHERE c.lakehouseId=@id` (+ tenant filter). Returns registry rows. No external dependency → always works. |
| `/api/items/lakehouse/[id]/shortcuts` | **POST** | Validate body. Resolve `abfssUri`. Branch by section+engine: **(a)** *Tables + Databricks* → `executeStatement`: ensure `STORAGE CREDENTIAL` (UAMI/KV), `CREATE EXTERNAL LOCATION IF NOT EXISTS`, `CREATE TABLE loom.<lh>.<name> LOCATION '<abfss>'`; **(b)** *Tables + Synapse* → `executeQuery`: `CREATE EXTERNAL DATA SOURCE` (+ scoped credential if KV), `CREATE EXTERNAL FILE FORMAT`, `CREATE EXTERNAL TABLE [shortcuts].[<name>]` (or `CREATE VIEW ... OPENROWSET`); **(c)** *Files* → no DDL, just resolve URI + a real `listPaths`/`getProperties` "Test connection" to prove reachability. Upsert the Cosmos row with `status` + `engineObject`. |
| `/api/items/lakehouse/[id]/shortcuts/[name]` | **DELETE** | Drop engine object (`DROP TABLE IF EXISTS` / `DROP EXTERNAL TABLE`) — **never** delete underlying source bytes (matches UC/Fabric semantics) — then delete the Cosmos row. |
| `/api/items/lakehouse/[id]/shortcuts/[name]/test` | **POST** | Re-run the engine read (`SELECT TOP 1` / `listPaths`) and update `status`/`statusDetail`. Powers the Status chip + Test action. |
| `/api/items/lakehouse/[id]/shortcuts/browse` | **GET** | (Phase 1.5) For internal/ADLS targets, `listPaths` on the target account+path so the wizard can tree-browse (Fabric "browse the source" step). |
| `/api/items/lakehouse/[id]/shortcuts/sources` | **GET** | Lists available **internal** Loom lakehouses (from Cosmos `items`) + which external engines are configured (Databricks/Synapse gates) so the wizard can badge "ready" vs "needs credential". |

**Engine selection rule:** prefer **Databricks** when `databricksConfigGate()` passes (UC gives true table registration queryable by Spark + SQL Warehouse); else **Synapse Serverless** when `LOOM_SYNAPSE_WORKSPACE` set; else for Files-only shortcuts, neither is required. If a Tables shortcut is requested with neither engine configured, return an honest gate naming `LOOM_DATABRICKS_HOSTNAME` **or** `LOOM_SYNAPSE_WORKSPACE`.

**Reuse:** `executeStatement` (`databricks-client.ts`), `executeQuery`/`serverlessTarget` (`synapse-sql-client.ts`), `listPaths`/`getMetadata`/`pathToHttpsUrl` (`adls-client.ts`), `cosmos-client.ts` containers, `databricksConfigGate()`.

---

## 6. Bicep / RBAC / config needs

Per `no-vaporware.md` bicep-sync requirement. Most plumbing already exists (`modules/landing-zone/{storage,databricks,synapse,cosmos}.bicep`; env in `modules/admin-plane/main.bicep`).

1. **Cosmos container** — add `lakehouse-shortcuts` (PK `/lakehouseId`). Created lazily by `cosmos-client.ts` `createIfNotExists`; **also** add to any Cosmos init deploymentScript so a clean redeploy provisions it. No new env (uses `LOOM_COSMOS_*`).
2. **No new app env vars are strictly required for the ADLS/internal happy path** — `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL`, `LOOM_UAMI_CLIENT_ID`, `LOOM_DATABRICKS_HOSTNAME`, `LOOM_SYNAPSE_WORKSPACE`, `LOOM_SUBSCRIPTION_ID`, `LOOM_DLZ_RG`, `LOOM_COSMOS_*` already wired.
3. **UAMI RBAC on ADLS** — Console UAMI needs **Storage Blob Data Reader** (+ "Generate user delegation key", included in that role) on **each external ADLS account** a shortcut targets. For cross-account targets, add the role assignment in the target account's bicep (or document a one-time `az role assignment create` in `v3-tenant-bootstrap.md`). Internal medallion account already granted.
4. **Databricks Unity Catalog** — a UC **metastore** assigned to the workspace, a **storage credential** (Access Connector / managed identity) and the privilege to `CREATE EXTERNAL LOCATION` / `CREATE EXTERNAL TABLE`. Add an Access Connector + `Microsoft.Databricks/accessConnectors` role assignment (Storage Blob Data Contributor on target accounts) to `databricks.bicep`, and a SCIM/bootstrap step granting the Console identity `CREATE EXTERNAL LOCATION` + `CREATE TABLE` on a `loom` catalog. Gate honestly if absent.
5. **Synapse Serverless** — Console UAMI already needs `CONNECT`+`db_datareader` + firewall allow (documented in `v3-tenant-bootstrap.md` and the query route's gate). For external **credentialed** sources add `CREATE DATABASE SCOPED CREDENTIAL`/`EXTERNAL DATA SOURCE` privilege (`CONTROL`/`ALTER ANY EXTERNAL DATA SOURCE`) for the UAMI in the serverless DB bootstrap.
6. **Key Vault** — for S3/GCS/SAS/account-key/SP credentials, store the secret in the admin-plane Key Vault; grant Console UAMI **Key Vault Secrets User**. Add `credentialRef.keyVaultSecret` resolution in the BFF. (Honest-gated source types until configured.)

**Acceptance:** `az deployment sub create -f platform/fiab/bicep/main.bicep` + bootstrap workflow yields a Loom where an ADLS Gen2 / internal-lakehouse Tables shortcut creates a real UC/Synapse external table and queries it, with no Fabric in the loop.

---

## 7. No-Fabric-dependency audit (repo-wide)

`grep` for `api.fabric.microsoft.com` / `fabric-client` / `LOOM_FABRIC` / `onelake.dfs.fabric` surfaced ~50 files. Triage of what **hard-depends** on Fabric vs merely mimics it:

**HARD Fabric dependency that breaks for a no-Fabric tenant — flagged:**
- `app/api/catalog/shortcut/route.ts` + `lib/azure/fabric-client.ts` `createOneLakeShortcut`/`listOneLakeShortcuts`/`deleteOneLakeShortcut` → **the subject of this redesign.** Replace usage in the Lakehouse editor with the new `/api/items/lakehouse/[id]/shortcuts` routes. (The Fabric functions may stay as an *optional* internal-OneLake path, never required.)
- `lib/editors/lakehouse-editor.tsx` shortcuts tab — the Fabric workspace/item binding + cloud-connection GUID requirement. **Replace** (this doc).
- `app/api/fabric/workspaces/route.ts`, `lib/panes/onelake-catalog.tsx`, `app/api/realtime-hub/*`, `app/api/deployment-pipelines/*`, `lib/azure/onelake-catalog-client.ts` — these call Fabric REST directly. They are **separate surfaces** (OneLake catalog, real-time hub, deployment pipelines) and out of scope here, but each is a Fabric-dependency to audit independently against `ui-parity.md`. Recommend a follow-up ticket: "every Fabric-bound surface must either (a) have an Azure-native backend or (b) be honest-gated behind `LOOM_FABRIC_BASE` configured." Flag, do not fix here.

**Mimics Fabric but already Azure-native (no action):**
- Lakehouse Files/Preview/SQL/Tables tabs → ADLS Gen2 + Synapse Serverless (correct).
- `lib/editors/mirrored-databricks-editor.tsx`, most `phase3/phase4` editors reference "Fabric" in copy/types only.

**Net:** the only place the Lakehouse editor truly *requires* Fabric is the Shortcuts tab. Fixing it removes the lakehouse's last hard Fabric dependency.

---

## 8. Build plan — PR-sized chunks

**PR 1 — Data model + read paths (no UI change).**
- Add Cosmos `lakehouse-shortcuts` container (`cosmos-client.ts` + accessor + Cosmos init step).
- `lib/azure/lakehouse-shortcut-registry.ts`: `listShortcuts`, `upsertShortcut`, `deleteShortcut`, `getShortcut` (pure Cosmos, unit-tested with the existing Cosmos test harness).
- BFF `GET /api/items/lakehouse/[id]/shortcuts` + tests. *Receipt: GET returns `[]` then a seeded row.*

**PR 2 — ADLS + internal create/delete (UAMI happy path).**
- `lib/azure/shortcut-engines.ts`: `resolveAbfss()`, `createTablesShortcut()` dispatching to Databricks (`executeStatement`) or Synapse (`executeQuery`), `createFilesShortcut()` (resolve + `listPaths` test), `dropShortcutObject()`.
- BFF `POST` + `DELETE` + `/test` routes with honest engine gates. *Receipt: POST an ADLS Tables shortcut → real `CREATE EXTERNAL TABLE` → `SELECT` returns rows; DELETE drops the table not the data.*

**PR 3 — Editor UX swap.**
- Replace the Shortcuts tab block in `lakehouse-editor.tsx`: remove Fabric binding/localStorage/connectionId; new 3-step wizard; new list with status/test/open/delete; wire right-click "New shortcut…" to pre-fill section+path; chain-icon overlay in Files/Tables trees. *Receipt: Playwright walk creating + querying + deleting a shortcut with a minted session.*

**PR 4 — S3 / GCS / S3-compat / Dataverse with Key Vault credentials.**
- `credentialRef` → Key Vault secret resolution; UC storage credential / Synapse scoped credential / Spark conf wiring; honest-gate MessageBars when KV secret/role absent.
- `/sources` + `/browse` routes for the wizard's source picker + tree-browse. *Receipt: S3 shortcut with a KV-stored key creates a real UC external location + table.*

**PR 5 — Bicep + RBAC sync + docs.**
- Databricks Access Connector + UC privileges in `databricks.bicep`; Synapse scoped-credential grants in serverless bootstrap; KV Secrets User for UAMI; `v3-tenant-bootstrap.md` updates; `docs/fiab/parity/lakehouse-shortcuts.md` parity artifact (inventory ✅/⚠️/❌). *Receipt: clean-sub `az deployment` + bootstrap produces a working ADLS/internal shortcut with no manual steps.*

**PR 6 (optional/Phase 2) — caching, schema shortcuts, retention, audit-log entries.**

---

## 8a. Day-one-shippable core — AS BUILT (2026-06-01)

The day-one core (PR 1+2+3 combined, plus the external honest-gate from PR 4) is shipped:

- **Registry** — Cosmos container `lakehouse-shortcuts` (PK `/lakehouseId`) added to
  `cosmos-client.ts` `ensure()` via `mk()` + `lakehouseShortcutsContainer()` accessor;
  client lib `lib/azure/lakehouse-shortcuts.ts` (`listShortcuts`, `getShortcut`,
  `createShortcut` [deterministic-id upsert], `updateShortcutStatus`, `deleteShortcut`).
  The `kind` field is `'files'|'tables'` per the task contract (the `section` Files/Tables
  in §3 maps from `kind`).
- **Engines** — `lib/azure/shortcut-engines.ts`: `parseAbfss`, `resolveAndTestAdls`
  (real UAMI `listPaths` reachability), `pickTablesEngine` (Synapse preferred when
  `LOOM_SYNAPSE_WORKSPACE`, else Databricks UC when `LOOM_DATABRICKS_HOSTNAME`, else gate),
  `createTablesShortcut` (Synapse `CREATE VIEW … OPENROWSET` / Databricks `CREATE TABLE …
  USING <fmt> LOCATION`), `dropShortcutObject`, `externalSourceGate` (S3/GCS/Dataverse).
- **BFF routes** — placed at `app/api/lakehouse/shortcuts/` (sibling of the existing
  `app/api/lakehouse/*` ADLS routes the editor already uses) rather than the
  `/api/items/lakehouse/[id]/shortcuts` path sketched in §5; the registry is keyed by
  `lakehouseId` carried in the body/query, so a flat namespace is sufficient and consistent
  with `containers/paths/upload/permissions/settings`. `route.ts` = GET list / POST create /
  DELETE; `test/route.ts` = re-validate + status update.
- **UI** — `lakehouse-editor.tsx` Shortcuts tab: **New shortcut** 3-step wizard
  (source picker → connection/location → name+placement+review), list with
  Name/Path/Source/Engine/Status/Actions (Query · Test · Delete), right-click
  **New shortcut…** pre-fills section+sub-path. The lakehouse id used for the registry is
  the selected ADLS container (the Loom "lakehouse" == medallion container).

**Works by default (UAMI, no extra creds):** ADLS Gen2 + internal Loom lakehouse — Files
(pointer + reachability test) and, when a Tables engine is configured, Tables (real external
table). **Honest-gated:** S3 / GCS / Dataverse (the wizard renders + saves a `credentialRef`,
but create 503s naming the KV secret); Tables shortcuts when neither
`LOOM_SYNAPSE_WORKSPACE` nor `LOOM_DATABRICKS_HOSTNAME` is set (503 naming both).

**Bicep / env:** No new env vars. The `lakehouse-shortcuts` container is created lazily by
`cosmos-client.ts` `createIfNotExists` on first access, so a clean
`az deployment sub create` + the existing Cosmos init provisions it with no extra step —
matching every other Loom container. UAMI RBAC on cross-account ADLS targets (Storage Blob
Data Reader) and the UC/Synapse credential wiring for external clouds remain as documented in
§6 / PR 4-5.

---

## 9. Biggest technical risk

**Unity Catalog external-table registration permissions and storage-credential provisioning.** The Databricks path is the only way to get a *true* Fabric-parity "Tables shortcut" (a named Delta table queryable from both Spark and a SQL endpoint, auto-recognized). But it requires a UC **metastore** attached to the workspace, an **Access Connector / storage credential** with Storage Blob Data Contributor on every target account, and the Console identity holding `CREATE EXTERNAL LOCATION` + `CREATE EXTERNAL TABLE` + `EXTERNAL USE LOCATION` — privileges that **cannot** be granted purely from ARM/bicep (they are UC data-plane grants requiring a metastore admin and a SCIM-provisioned principal). If UC isn't fully bootstrapped in a given tenant, Tables-shortcut creation fails. **Mitigation:** make **Synapse Serverless** (`CREATE EXTERNAL TABLE`/`OPENROWSET` view, which Loom already authenticates to) the **default Tables engine**, treat Databricks UC as the preferred-when-available upgrade, and **honest-gate** any path that needs UC bootstrap with the exact metastore/grant/Access-Connector remediation. This keeps the feature functional end-to-end on the UAMI-only path while still reaching full UC parity where the tenant has provisioned Unity Catalog.
