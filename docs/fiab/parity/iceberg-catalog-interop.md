# iceberg-catalog-interop — parity with a managed Iceberg REST Catalog (Databricks Unity Catalog IRC / Snowflake Open Catalog / Fabric OneLake Iceberg endpoint)

**Item:** N1 (loom-next-level) — Iceberg REST catalog + Delta↔Iceberg dual metadata
**Surfaces:** `/admin/catalog` (catalog federation) · lakehouse editor → **Interop** tab
**Backend (operator decision):** **Unity Catalog OSS** as an internal-ingress Azure Container App
(`platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep`). Apache Polaris is a footnote, not an option.

Source UI / spec this is measured against:

- Apache Iceberg REST Catalog OpenAPI spec — <https://iceberg.apache.org/docs/latest/rest-catalog-spec/>
- Databricks Unity Catalog "Iceberg REST catalog" endpoint (`/api/2.1/unity-catalog/iceberg`)
- Delta Lake UniForm (`delta.enableIcebergCompatV2`, `delta.universalFormat.enabledFormats`)
- Apache XTable (incubating) omni-directional Delta↔Iceberg↔Hudi conversion
- Microsoft Fabric OneLake "Iceberg endpoint" / table virtualization (the Fabric behaviour Loom matches Azure-natively)

---

## The problem N1 solves

Loom was **Delta-only** and interop stopped at the Synapse Serverless TDS endpoint: an external engine could
only reach Loom data through a SQL endpoint, one query at a time. Every other lakehouse vendor's answer is
"export a copy". N1's answer is a standard **Iceberg REST Catalog (IRC)** over the **same customer-owned ADLS
Gen2 files** — Trino, Spark, DuckDB, Snowflake and Databricks read Loom tables **in place, zero copy**.

---

## Feature inventory → Loom coverage

### A. Iceberg REST Catalog surface (the spec external engines speak)

| # | IRC capability | Loom coverage | Backend per control |
|---|---|---|---|
| A1 | `GET /v1/config?warehouse=` handshake | ✅ `GET /api/catalog/iceberg/config` | `iceberg-catalog-client.getCatalogConfig` → UC OSS |
| A2 | `GET /v1/namespaces[?parent=]` | ✅ `GET /api/catalog/iceberg/namespaces` | `listNamespaces` |
| A3 | `POST /v1/namespaces` (create) | ✅ `POST /api/catalog/iceberg/namespaces` | `createNamespace` |
| A4 | `GET /v1/namespaces/{ns}/tables` | ✅ `GET /api/catalog/iceberg/tables?namespace=` | `listTables` |
| A5 | `GET /v1/namespaces/{ns}/tables/{t}` (load) | ✅ `GET /api/catalog/iceberg/table?namespace=&table=` | `loadTable` — returns real `metadata-location`, `format-version`, `table-uuid`, snapshot id, properties |
| A6 | `POST /v1/namespaces/{ns}/register` | ✅ `POST /api/catalog/iceberg/tables` | `registerTable` — registers the metadata **pointer**; no data moves |
| A7 | `DELETE …/tables/{t}` (drop) | ✅ `DELETE /api/catalog/iceberg/tables` | `dropTableRegistration` — **`purgeRequested=false` is pinned in the client**, so a catalog de-registration can never delete customer data |
| A8 | Multi-level namespaces (U+001F separator) | ✅ `encodeNamespace` / `namespaceToDotted` | spec-correct `%1F` joining + identifier validation (traversal/injection rejected before the URL is built) |
| A9 | OAuth2 / bearer auth for engines | ✅ scoped **Loom API token** (PAT) on the proxy | `getApiSession` + `enforcePatAccess` — a read-only token cannot mutate |
| A10 | Credential vending to the engine | ⚠️ honest-gate — served by UC OSS when the catalog app is deployed with a lake credential; Trino snippet enables `vended-credentials-enabled`. Without it, engines use their own ADLS identity. |
| A11 | Grants / ACLs on catalog securables | ✅ `listNamespaceGrants` reads the real UC `permissions/schema/{catalog}.{schema}` surface; a server without the ACL API reports `supported:false` **with the reason**, never a fabricated empty ACL |

### B. Delta↔Iceberg dual metadata (the write path)

| # | Capability | Loom coverage | Backend per control |
|---|---|---|---|
| B1 | Enable Iceberg reads on a Delta table | ✅ Interop tab switch → `PUT /api/lakehouse/interop` | Real **Synapse Spark Livy** statement: `ALTER TABLE delta.\`<abfss>\` SET TBLPROPERTIES('delta.enableIcebergCompatV2','delta.universalFormat.enabledFormats'='iceberg')` |
| B2 | Upgrade an existing table (deletion vectors / old protocol) | ✅ automatic fallback | `REORG TABLE … APPLY (UPGRADE UNIFORM(ICEBERG_COMPAT_VERSION=2))` |
| B3 | Runtime without UniForm | ✅ Apache XTable fallback, **honestly reported** | reflective classpath probe; absent → `xtable-unavailable` naming the exact jar to add. No silent success. |
| B4 | Verify the metadata actually materialised | ✅ | the job lists `<table>/metadata` through Hadoop FS and prints a parseable `loom-iceberg-metadata {…}` receipt (`parseIcebergEmitReceipt` refuses to invent a success) |
| B5 | Disable Iceberg generation | ✅ same switch, off | `UNSET TBLPROPERTIES IF EXISTS ('delta.universalFormat.enabledFormats')` — data files and `_delta_log` untouched, so **Delta ✓ can never be lost** |
| B6 | Run it as part of table maintenance | ✅ | `icebergMetadata` is a first-class op on the existing `delta-maintenance` request/PySpark builder, emitted **after** OPTIMIZE so the registered snapshot points at compacted files |
| B7 | Job tracking | ✅ | the job is written to the SAME `maintenance-jobs` container, so the existing `GET /api/lakehouse/maintenance` poller submits + tracks it to a terminal state — one job engine, one jobs list |
| B8 | No Databricks dependency | ✅ | the pre-existing UniForm toggle in `/api/lakehouse/settings` needs a Databricks SQL Warehouse; **this path runs on Synapse Spark** and works with `LOOM_DATABRICKS_HOSTNAME` unset |

### C. `/admin/catalog` — catalog federation surface

| # | Capability (from the managed-catalog UIs) | Loom coverage | Backend |
|---|---|---|---|
| C1 | Namespace browser | ✅ namespace dropdown + filter | `/api/catalog/iceberg/overview` |
| C2 | Table listing with **format badges** | ✅ Delta ✓ / Iceberg ✓ per row | catalog listing JOINed onto real `loom-lakehouse-interop` state — never assumed |
| C3 | Table provenance | ✅ `catalog` / `lake` / `both` source badge | a table Loom exposed but the catalog has not listed yet still renders (it IS readable via its metadata folder) |
| C4 | Metadata location per table | ✅ | real `abfss://…/metadata` from the interop store |
| C5 | External-engine connection strings | ✅ Spark / Trino / DuckDB / Snowflake / Databricks tabs, copy button | `buildConnectSnippets` — real engine config; the bearer is **always** a `<loom-api-token>` placeholder, never a live secret |
| C6 | Grant mapping | ✅ principal × privileges per namespace | `listNamespaceGrants` |
| C7 | KPI summary | ✅ namespaces / tables / Iceberg-readable / grant assignments | derived from the same real payload |
| C8 | Honest gate + Fix-it | ✅ | `HonestGate gateId="svc-iceberg-catalog"` — inline Fix-it wizard, registry row, `/admin/gates` link. **The full page still renders** when the catalog is unset |
| C9 | Guided empty state | ✅ `EmptyState` + "Browse lakehouses" CTA | teaches the Interop-tab workflow instead of showing an empty grid |

**Zero ❌.** The single ⚠️ (A10) is an honest capability note, not a stub: the surface renders and the
snippets work; credential vending is a catalog-server configuration, and the fallback (engine-side ADLS
identity) is stated in the Trino snippet note.

---

## Security posture

- The catalog Container App has **internal ingress only** and is never public. The **only** door is the Loom
  BFF proxy (`/api/catalog/iceberg/*`), which authenticates the caller (session cookie **or** scoped API
  token), then **injects an Entra bearer** for the upstream hop. A caller's own credential is never forwarded.
- Anonymous callers get **401 before the config gate is evaluated**, so a probe cannot learn the deployment's
  configuration state.
- **Every IRC read and write writes an `_auditLog` data-access row** (principal, namespace/table scope,
  operation, timestamp, outcome, workspace scope, `viaApiToken`) and fans out through `emitAuditEvent`.
  High-volume LIST reads aggregate into one row carrying `resultCount`. Failures are audited too, so a denied
  read still leaves evidence.
- Identity-based storage auth end to end: the catalog's UAMI gets **Storage Blob Data Reader** on the DLZ lake
  via an in-bicep, `guid()`-guarded role assignment. **No storage keys, no secrets in app settings.**

## Per-cloud availability

| Cloud | Status | Note |
|---|---|---|
| Commercial | GA | |
| GCC-High | GA | |
| IL5 / air-gapped | **GA — fully in-boundary** | The catalog is a self-hosted OSS container on the deployment's own Container Apps environment reading the deployment's own ADLS Gen2 over the VNet. There is **no SaaS catalog** anywhere in the path (no Tabular, no Snowflake Open Catalog, no Databricks-hosted Unity Catalog, no Fabric/OneLake). Dual metadata is written by the deployment's own Synapse Spark. **This is the sovereign moat for data interop:** a disconnected enclave can still hand Trino a working, governed Iceberg catalog. |

## Cost

+$100–200/mo/cloud. The catalog is `minReplicas: 1` (never scale-to-zero) because it sits on the metadata hot
path for every external-engine query plan.

## Default-ON / honest-gate behaviour

`svc-iceberg-catalog` is `optionalDefault` — **unset is a fully functional state**, not a configuration gap:
the Interop tab still writes real Iceberg V2 metadata into the customer's own lake and any engine can be
pointed straight at the metadata folder. Deploying the catalog adds *discovery* + credential vending; it is
never on the data path. `LOOM_DEFAULT_FABRIC_WORKSPACE` is unset throughout — nothing here reads it.

## Flags / registry wiring

- Runtime flag: `n1-lakehouse-interop-tab` (default-ON, admin-flippable at `/admin/runtime-flags`).
  OFF hides the tab on the next render; already-emitted Iceberg metadata stays in the lake and external
  engines keep reading it.
- Gate: `svc-iceberg-catalog` in `lib/admin/env-checks/data-plane.ts` + `lib/gates/registry/data-plane.ts`
  with `availability` and an `env-picker` Fix-it.
- Cosmos: `loom-lakehouse-interop` (PK `/tenantId`), MIG1-registered via the leaf model
  `lib/azure/lakehouse-interop-model.ts`, ARM-provisioned in `landing-zone/cosmos.bicep`.
- Health coverage: `iceberg-catalog-client` → `svc-iceberg-catalog`.

## Verification

- Unit: `lib/azure/__tests__/iceberg-metadata.test.ts`, `lib/azure/__tests__/iceberg-catalog-client.test.ts`,
  `app/api/catalog/iceberg/__tests__/iceberg-proxy.test.ts`.
- Render: `lib/editors/lakehouse/__tests__/interop-pane.test.tsx`,
  `app/admin/catalog/__tests__/admin-catalog-page.test.tsx` (both include the honest-gate state).
- **Pending (G1):** in-browser E2E receipt — expose a real Delta table from the Interop tab, watch the Livy
  job reach `succeeded`, confirm `metadata/` materialises in ADLS, then `SELECT` the table from Trino and
  DuckDB through the proxy with a scoped Loom API token. This doc is not A-grade until that receipt is
  attached.
