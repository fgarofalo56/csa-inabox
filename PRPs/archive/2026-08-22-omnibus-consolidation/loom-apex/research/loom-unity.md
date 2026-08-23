# Loom Unity — Databricks Unity Catalog parity platform for Gov/FedRAMP (deep-research audit)

Date: 2026-07-24 · Agent: read/research (audit2) · Scope: full UC feature inventory → Loom coverage → gap table → "Loom Unity" architecture + phasing.
All repo claims cite `file:line`. Classification legend: **ALREADY-BUILT** / **OPERATOR-GATED** / **REAL-GAP** / **STALE-DOC**.

---

## 0. Executive summary

- Loom already ships a **remarkably complete Databricks Unity Catalog client** (2,856-line `unity-catalog-client.ts`) covering the three-level namespace, grants (REST + SQL), tags/governed tags, ABAC policy DDL, row filters/column masks, lineage (REST preview + `system.access` table/column lineage), Delta Sharing (bidirectional), system tables (audit/billing/query/classification/quality), workspace bindings, federation connections/foreign catalogs, metric views, clean rooms, online tables, Marketplace consumer, and managed-Iceberg/UniForm table formats — **on the Databricks backend** (Commercial).
- For **Gov/FedRAMP**, Databricks UC has **no Azure Government endpoint** (`docs/fiab/unity-gov.md:11-16`), so Loom deploys the **OSS Unity Catalog server** (`loom-unity` Container App, Apache-2.0, license-clean) as the Gov default backend, speaking the *same* `/api/2.1/unity-catalog/*` REST. On OSS, the object surface + grants + storage credentials + external locations + credential vending + **Iceberg REST Catalog** work today; Delta Sharing, lineage, ABAC, tags, system tables, bindings, and federation are **honestly 501-gated** (`lib/azure/uc-backend.ts:119-131`).
- The **flagship gap** is therefore not "build a UC client" — it is **closing the OSS-backend governance families with FedRAMP-High-compatible, license-clean Loom-native services**, because upstream OSS UC's roadmap marks Delta Sharing, lineage, ABAC, row filters, column masks, federation, and RBAC all as ❓ (not shipped) as of v0.5.1 (2026-07-18).
- Proposal: **"Loom Unity"** — keep the deployed OSS UC server as the metastore control plane, move persistence to **Azure Database for PostgreSQL Flexible Server (AAD-only)**, add a **Loom-native governance overlay** (Cosmos: tags/certification/business metadata/effective-grants/audit) fronted by the existing BFF, enforce ABAC by **compiling policies to each engine** (the compiler skeleton already exists at `lib/governance/policy-code/compilers/unity-catalog.ts`), fold lineage through the **already-built unified-lineage merge**, and stand up the **OSS `delta-sharing` reference server** (Apache-2.0) for open-protocol sharing in Gov. 12 M-sized items, phased below.

Item counts: **34 inventory rows**, of which **17 ALREADY-BUILT (Databricks path) / 8 ALREADY-BUILT (both backends) / 9 REAL-GAP on the Gov (OSS) path**, plus 3 OPERATOR-GATED and 2 STALE-DOC findings.

---

## 1. EXHAUSTIVE Databricks Unity Catalog + Unity platform feature inventory (official docs)

Grounded in Databricks/Microsoft Learn docs (searched 2026-07-24):

| # | UC feature family | Detail |
|---|---|---|
| F1 | Three-level namespace | metastore → catalog → schema → object; `catalog.schema.object` addressing |
| F2 | Managed & external tables | Delta default; Managed Iceberg + UniForm (Delta w/ Iceberg metadata); foreign tables (read-only, from federation) |
| F3 | Views / materialized views / streaming tables | securables in the same namespace |
| F4 | Volumes (managed/external) | file governance under schemas |
| F5 | Functions (UDFs) | incl. mask/filter functions; models governed via FUNCTION securable |
| F6 | Registered models + versions | MLflow-backed, UC securable |
| F7 | Vector search / AI Search indexes | implemented as a UC table type ([docs](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/vector-search)) |
| F8 | Storage credentials | Azure managed identity (Access Connector) backed |
| F9 | External locations | URL + credential binding, isolation mode |
| F10 | Temporary credential vending | table/volume/path scoped short-lived creds (delegation SAS on Azure) |
| F11 | Privilege model (grants) | GRANT/REVOKE per securable; inheritance; `effective-permissions`; ownership |
| F12 | Row filters & column masks | per-table UDF-bound; plus **ABAC policies** (tag-driven row-filter/column-mask policies, **GA ~May 2026**; policy evaluation vs session user change eff. 2026-04-28) |
| F13 | Governed tags + object/column tags | `SET TAGS` DDL + `information_schema.*_tags`; governed-tag allowed values |
| F14 | Certification / deprecation | system `certification_status` tag ([docs](https://docs.databricks.com/aws/en/data-governance/unity-catalog/certify-deprecate-data)) |
| F15 | Business metadata | comments, tags, request-for-access, Catalog Explorer discovery |
| F16 | Lineage — table + column | `system.access.table_lineage` / `column_lineage` (entity-aware: notebook/job/pipeline) + `/api/2.0/lineage-tracking` preview |
| F17 | System tables | `system.access.audit`, `system.billing.usage`, `system.query.history`, `system.data_classification.results`, `system.data_quality_monitoring.table_results`, lineage schemas |
| F18 | Auto data classification | UC-native PII detection (GA with ABAC wave) |
| F19 | Lakehouse monitoring / data-quality monitors | per-table monitors + system-table results |
| F20 | Delta Sharing — open (TOKEN) | recipient activation profiles, open protocol to any client |
| F21 | Delta Sharing — D2D (DATABRICKS) | metastore-to-metastore via global metastore id |
| F22 | Shares / recipients / providers CRUD + share permissions | incl. mounting inbound shares as read-only catalogs |
| F23 | Catalog federation / foreign catalogs | `CREATE CONNECTION` + `CREATE FOREIGN CATALOG` (SQL Server/Synapse/Postgres/Snowflake/HMS/Glue…) ([docs](https://docs.databricks.com/aws/en/query-federation/catalog-federation)) |
| F24 | Workspace–catalog bindings | catalog `isolation_mode` OPEN/ISOLATED; binding API as security boundary |
| F25 | Identity federation / SCIM | account-level users/groups synced from IdP; identity federation to workspaces |
| F26 | Metric views (semantic layer) | YAML metrics as UC securables, `MEASURE()` queries |
| F27 | Genie | NL-over-semantic-layer assistant grounded in UC metadata |
| F28 | Online tables / feature serving | low-latency copies of UC feature tables |
| F29 | Clean rooms | cross-org privacy-safe collaboration (UC securable) |
| F30 | Databricks Marketplace | consumer listings/installations → Delta-Sharing providers |
| F31 | Iceberg REST Catalog endpoint | UC serves IRC for external engines |
| F32 | Audit of grants/usage | audit system table + verbose audit logs |
| F33 | Metastore admin model | owner/admin roles, `metastore_summary`, delta-sharing scope |
| F34 | Search/discovery | Catalog Explorer search, request access workflows |

### OSS Unity Catalog (unitycatalog/unitycatalog) upstream state — the Gov building block

- **License: Apache-2.0** — license-clean (no AGPL/BSL). Verified via GitHub README (fetched 2026-07-24).
- **Latest release: v0.5.1 (2026-07-18)** — patch for credential-caching, authz fixes, connector artifacts. Loom pins **v0.5.0** (`docs/fiab/unity-gov.md:22`).
- Shipped upstream: tables (incl. **managed Delta / catalog-managed commits**, v0.5), volumes, functions, models+versions, external locations, credentials, temporary credential vending, grants (permissions API), OAuth/OIDC user auth, **Iceberg REST catalog API compatibility**, metric views (🛠 experimental in 0.5).
- **NOT shipped upstream (roadmap ❓):** Delta Sharing, lineage, ABAC, row-level filters, column masks, federation, RBAC, SAML. ⇒ every OSS-path gap Loom gates must be closed **Loom-side**, not by waiting for upstream.

---

## 2. What Loom ALREADY has, per feature (evidence)

### 2.1 The UC client + backend switch (both backends)

- **Dual-backend client**: one client speaks Databricks UC *or* the self-hosted OSS UC server; `ucFetch` routes on `isOssUc()` — `lib/azure/unity-catalog-client.ts:192-254`; backend resolution (`LOOM_UC_BACKEND`, Gov auto-select) — `lib/azure/uc-backend.ts:46-54`. Databricks default Commercial; OSS default Gov (`uc-backend.ts:2-14`).
- **Honest 501 gating of Databricks-only families on OSS** — `uc-backend.ts:119-131`; storage-credential↔credential path rewrite — `uc-backend.ts:142-147`.
- **Capability matrix as code** (`UC_CAPABILITIES`, 23 rows, per-backend support + Loom-native fallback note per row), served at `/api/catalog/unity/capabilities` — `uc-backend.ts:175-199`; route dir `app/api/catalog/unity/capabilities` exists. Doc twin: `docs/fiab/unity-catalog-capability-matrix.md`.
- Multi-workspace **metastore federation** + Cosmos-persisted workspace registrations — `unity-catalog-client.ts:107-184` (Cosmos `metastore-registrations` union at :169-181).

### 2.2 Feature-by-feature (client + surfaces)

| UC feature | Loom implementation | Backend coverage |
|---|---|---|
| F1 namespace, catalogs/schemas CRUD | `unity-catalog-client.ts:407-453,497-531` | both |
| F2 tables (list/get/create/delete), Managed Iceberg/UniForm DDL | REST create :541-570; `createUcTableWithFormat` (DBX-11) :1729-1738 | both (formats: Databricks only) |
| F4 volumes CRUD | :471-495,521-531 | both |
| F5 functions CRUD | :593-610 | both |
| F6 models + versions | :2247-2272 (models REST; governed via FUNCTION path :671-685) | both |
| F8/F9 storage credentials + external locations CRUD | :1806-1871 | both |
| F10 temp credential vending (table/volume/path) | :630-658; OSS vending via `LOOM_UNITY_ADLS_*` SP | both (OSS = opt-in SP) |
| F11 grants — REST PATCH + real SQL GRANT/REVOKE; effective-permissions | :687-755 (effective = Databricks-only, :698-705) | both (effective: DBX only) |
| F12 row filters / column masks UI + DDL | `lib/panes/uc-security-panel.tsx:1-21` (guided wizards, `information_schema.column_masks/row_filters`, server-side SQL builders `lib/sql/uc-security-builders.ts`) | Databricks only |
| F12 ABAC policies (CREATE/DROP/SHOW POLICY) | :1641-1676 | Databricks only |
| F13 tags + governed tags (SET/UNSET, information_schema reads) | :1517-1635 | Databricks only |
| F16 lineage — REST preview, `system.access` table + column lineage (entity-aware) | :783-801, :859-984, :1042-1111 | Databricks only |
| F17 system tables — audit / billing / query history | :2117-2169 | Databricks only |
| F18 data classification (`system.data_classification.results`) | :2176-2193 | Databricks only |
| F19 quality monitors (config REST + `data_quality_monitoring` results) | :2312-2355 | Databricks only |
| F20-F22 Delta Sharing full bidirectional (shares/recipients/providers/mount + readiness probe) | :1196-1326, readiness :1422-1503; UI `lib/components/marketplace/data-shares.tsx:1-25` | Databricks only |
| F23 federation — connections list/get/delete + `CREATE CONNECTION`/`CREATE FOREIGN CATALOG` (secret()-safe DDL) | :1878-1918 | Databricks only |
| F24 workspace bindings + catalog isolation mode | :1976-2026 | Databricks only |
| F26 metric views (create/query/drop, MEASURE() compile) | :1686-1722 | Databricks only (OSS upstream: experimental 0.5, not wired) |
| F28 online tables CRUD | :2838-2855 | Databricks only |
| F29 clean rooms (list/get/assets/create/run task/runs) | :2620-2748 | Databricks only |
| F30 Marketplace consumer (listings/search/installations) | :2471-2505 | Databricks only |
| F31 Iceberg REST Catalog | **served by UC OSS itself** — N1 client `lib/azure/iceberg-catalog-client.ts:1-120`; bicep `platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep`; BFF proxy `/api/catalog/iceberg/*` with Entra bearer injection + per-call audit (:30-45) | **OSS (Gov-first)** |
| F33 metastore summary / system-schema enablement | :2038-2065 | Databricks (OSS: summary mapped :349-360) |
| F34 federated UC search | :1354-1387; catalog UI `/catalog/unity`, `federated-search.tsx` | both |

### 2.3 The Gov OSS deployment (loom-unity)

- Container App bicep: internal-ingress-only, UAMI pull, TCP probes, minReplicas=maxReplicas=1 — `platform/fiab/bicep/modules/compute/loom-unity-app.bicep:160-233`.
- Persistence: default H2-on-Azure-Files; **`dbEphemeral` escape hatch documents that H2-on-SMB CrashLoopBackOffs on Azure Government**; Postgres opt-in via `unityDbUrl` — `loom-unity-app.bicep:60-64,79-106`. (Matches operator memory: Gov OSS UC live since 07-14 with the H2-on-SMB failure worked around.)
- **Auth: `server.authorization=disable` by default; the VNet is the security boundary** — `docs/fiab/unity-gov.md:48-52`, `loom-unity-app.bicep:174-180`. OIDC opt-in (`LOOM_UNITY_AUTH=enable`), bearer via `LOOM_UNITY_TOKEN` (`uc-backend.ts:100-103`).
- Packaged server: `apps/loom-unity/{Dockerfile,bin,tests}`; deploy steps `docs/fiab/unity-gov.md:85-134`.

### 2.4 Loom-native equivalents already standing (the fallbacks the gates name)

- **Unified lineage** (Purview Atlas + UC + Weave/Thread edges merged on canonical identity incl. `col:<table>::<column>` column grain; OpenLineage ingest per capability note) — `lib/azure/unified-lineage.ts:1-90`; capability note `uc-backend.ts:190`.
- **Audit → SIEM**: every admin mutation → Azure Monitor Logs Ingestion (DCR → `LoomAudit_CL`, Sentinel rules) + Cosmos `_auditLog` — `lib/admin/audit-stream.ts:1-40`; IRC data-plane reads/writes audited — `iceberg-catalog-client.ts:37-45`.
- **Sharing (Gov)**: Loom Marketplace shares + subscribe→access (`app/api/marketplace/sharing/*`), plus **cross-tenant external shares = Entra B2B guest + scoped ADLS grant** — `app/api/external-shares/route.ts:1-18`.
- **Business metadata**: attribute groups (Purview-vocabulary custom metadata, Cosmos-backed) — `lib/types/attribute-groups.ts:1-30`.
- **Sensitivity labels + DLP**: Loom-native label taxonomy + label/DLP policy libraries — `lib/governance/label-policy-library.ts:1-27`, `lib/governance/dlp-policy-library.ts`.
- **Policy-as-code → UC compiler**: `PolicyCodeSet` → GRANT/REVOKE + ROW FILTER/COLUMN MASK DDL, with an explicit `ucVariant:'oss'` mode that emits grants only + honest warning — `lib/governance/policy-code/compilers/unity-catalog.ts:1-54`.
- **ABAC-ish enforcement elsewhere**: Synapse RLS/DDM (`lib/azure/rls-compiler.ts` reuse at compiler:15), workspace grants, governance domains.

---

## 3. GAP TABLE — UC feature | Loom today | gap | proposed Loom-Unity design

Focus = the **Gov/OSS path** (Commercial-with-Databricks is largely ALREADY-BUILT). Every proposed design is Azure-Gov-GA, in-VNet, AAD-only, license-clean (OSS UC + delta-sharing + OpenLineage + Trino are Apache-2.0; DuckDB MIT).

| UC feature | Loom today (evidence) | Gap class (OSS/Gov path) | Proposed Loom-Unity design |
|---|---|---|---|
| Namespace/tables/volumes/functions/models | Full CRUD both backends (§2.2) | **ALREADY-BUILT** | keep; pin upstream 0.5.1 |
| Storage credentials / external locations / vending | Built both backends; OSS vending needs `LOOM_UNITY_ADLS_*` SP (`uc-backend.ts:187`) | **OPERATOR-GATED** | Replace SP-secret vending with UAMI federated credential or KV `secretref`; wire into bicep |
| Grants | REST grants both backends (`UC_CAPABILITIES` grants:'full' oss, `uc-backend.ts:184`) | **ALREADY-BUILT** | keep |
| **Effective (inherited) permissions** | Databricks-only (:698-705) | **REAL-GAP** | Loom-side inheritance resolver in BFF (walk catalog→schema→object direct grants from OSS UC, compute effective set); no upstream change needed |
| **Row filters / column masks + ABAC policies** | Databricks DDL + panel only; OSS compiler emits warning (`compilers/unity-catalog.ts:5-9`) | **REAL-GAP** (flagship) | ABAC policies authored in Loom policy-code DSL (exists), compiled per engine: Synapse serverless **secure views** (RLS compiler exists), Trino row-filter/mask via file-based/OPA access control, DuckDB secure-view emit, Spark via view layer. Store policies in Cosmos; reconcile loop = `policy-code/reconcile.ts` |
| **Tags / governed tags** | Databricks SQL DDL only (:1517-1635); OSS 'none' (`uc-backend.ts:191`) | **REAL-GAP** | Cosmos governance-overlay tag store keyed on `uc:<full_name>` identity (same key as unified-lineage `normalizeIdentity`, `unified-lineage.ts:78-90`); surface in the same UC dialogs; sync to Purview classifications |
| **Certification / business metadata** | Attribute groups + labels Loom-native (§2.4) — not yet joined to UC objects | **REAL-GAP** (small) | Extend attribute-groups scope to UC securables; `certification_status` as a governed overlay tag |
| **Lineage (table+column)** | Databricks system tables built; OSS 'none' but Loom **unified column lineage default-ON** (`uc-backend.ts:190`, `unified-lineage.ts`) | **ALREADY-BUILT (Loom-native)** — gap is only "inside UC API" | Add OpenLineage HTTP ingest → thread-edges/Cosmos → unified-lineage L2/L3 (note says ingest exists — verify emitters from Synapse Spark/pipelines) |
| **System tables (audit/billing/query)** | Databricks reads built; OSS fallback = Log Analytics (`uc-backend.ts:193`) + audit-stream SIEM (§2.4) | **REAL-GAP** (surface) | "Loom Unity system tables" pane: KQL over `LoomAudit_CL` + Cosmos `_auditLog` + Synapse serverless query history; route ALL OSS UC calls through the BFF audit choke point (IRC pattern, `iceberg-catalog-client.ts:37-45`) |
| **Auto data classification** | Databricks system table only; Purview scans exist (`purview-autoonboard.ts`) | **ALREADY-BUILT (via Purview)** — Gov Purview classic works (memory: classification 59 classifiers) | Fold Purview classification results into UC-object overlay tags |
| **Delta Sharing (open + D2D)** | Databricks-only full stack (§2.2); Gov fallback = Marketplace shares + Entra B2B external shares (§2.4) | **REAL-GAP** (protocol parity) | Deploy OSS **delta-sharing reference server** (Apache-2.0) as `loom-sharing` ACA app over the same ADLS Delta tables; internal ingress + APIM/front-door for cross-boundary recipients; AAD-token recipients preferred over bearer profiles; Loom Marketplace "Data shares" surface points at it (UI already built, `data-shares.tsx`) |
| **Catalog federation / foreign catalogs** | Databricks-only (:1878-1918); Loom Linked Services/ADF connectors + **Trino federation opt-in (N7e)** shipped | **ALREADY-BUILT (alternative)** / partial | Represent Trino catalogs + Linked Services as read-only "foreign catalogs" rows in the /catalog/unity Federation tab; no fake UC connections on OSS |
| **Workspace bindings / isolation** | Databricks-only (:1976-2026); Loom workspace ACLs enforce isolation (`uc-backend.ts:194`) | **ALREADY-BUILT (alternative)** | Map Loom workspace→catalog visibility in BFF (deny-by-default listing filter); persist bindings in Cosmos |
| **Identity federation / SCIM** | AAD-only everywhere; but OSS UC runs **authorization disabled** in-VNet (`unity-gov.md:48-52`) | **REAL-GAP** (security posture) | Enable OSS UC OIDC vs Entra (upstream "modular authentication" v0.5), BFF injects bearer (`LOOM_UNITY_TOKEN` hook exists, `uc-backend.ts:100-103`); ACA network policy: only Console/BFF can reach loom-unity |
| **Metric views / semantic (Genie)** | Databricks metric views built (:1686-1722); Loom semantic-model + report layer + in-product Copilot exist | **REAL-GAP** (OSS wiring) | Wire OSS UC 0.5 experimental metric views behind a Preview badge; Genie-parity = Loom Copilot NL2SQL over metric views + semantic models (Copilot infra exists) |
| **Vector indexes** | Not a UC securable in Loom; Azure AI Search used elsewhere | **REAL-GAP** (metadata) | Register AI Search indexes (Gov GA) as UC-overlay securables (catalog rows + grants mapped to Loom ACLs) |
| Online tables | Databricks-only (:2838-2855) | OPERATOR-GATED fallback named: Lakebase/Postgres serving (`uc-backend.ts:196`) | keep fallback |
| Clean rooms / Databricks Marketplace | Databricks-only (:2620-2748, :2471-2505) | Not FedRAMP-pursuable 1:1 | Loom Marketplace is the Gov equivalent (built); document as intentional |
| Iceberg REST catalog | **Built on OSS UC** (N1) with BFF proxy + audit (§2.2 F31) | **ALREADY-BUILT** | Loom Unity's engine door — Trino/Spark/DuckDB/Snowflake attach here |
| Quality monitors | Databricks-only; fallback Great-Expectations-style checks (`uc-backend.ts:195`) | **REAL-GAP** (small) | Loom data-quality checks writing results to the overlay store, surfaced in the same monitors pane |

### OPERATOR-GATED (distinct from gaps)
1. `LOOM_DATABRICKS_HOSTNAME(S)` — the whole Databricks path (Commercial) is env-gated by design (`unity-catalog-client.ts:117-135`).
2. `LOOM_UNITY_ADLS_*` vending SP (default OFF; `unity-gov.md:130-134`).
3. `LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID` — system-table lineage vs REST-preview fallback (:815-817).

### STALE-DOC findings
1. **`docs/fiab/unity-gov.md:44-47,126-128`** says H2-on-Azure-Files is the default and "the recommended day-one path" — contradicted by the bicep itself, which documents that **H2-on-SMB CrashLoopBackOffs on Azure Government** and added `dbEphemeral` (`loom-unity-app.bicep:63-64`), and by the live Gov deployment running Postgres (operator memory 07-14). Doc should flip the Gov recommendation to Postgres/EmptyDir.
2. **`docs/fiab/unity-gov.md:22`** pins upstream **v0.5.0 (2026-06-18)**; upstream latest is **v0.5.1 (2026-07-18)** with credential-caching + authorization fixes — relevant precisely to the auth/vending items above; bump deliberately.

---

## 4. Proposed architecture — **Loom Unity**

### 4.1 Naming
Recommend **"Loom Unity"** — matches the existing app/module names (`loom-unity` ACA app, `LOOM_UNITY_URL`, `apps/loom-unity`), signals UC parity without claiming Databricks trademark scope, and reads as a Loom-first product (like Loom Marketplace / Loom Weave). Avoid "Unity Catalog for Gov" (implies Databricks endorsement).

### 4.2 Control plane
- **Metastore core = the deployed OSS UC server** (keep; Apache-2.0; same REST the client speaks). Persistence → **Azure Database for PostgreSQL Flexible Server, AAD-only auth** (Gov GA; note pgaadauth per-DB gotcha from the AGE work). Retire H2 in Gov (STALE-DOC #1). HA: today `minReplicas:1/maxReplicas:1` because H2 is single-writer (`loom-unity-app.bicep:227-232`) — Postgres unlocks ≥2 replicas.
- **Governance overlay = Loom-native Cosmos metadata layer** keyed on the canonical `uc:<catalog.schema.table>` / `col:<table>::<col>` identity already used by unified-lineage (`unified-lineage.ts:78-90`): tags, governed-tag definitions, certification, attribute-group values, ABAC policies, computed effective grants, quality results. The BFF composes overlay + UC REST into the existing `/catalog/unity` panes — the UI stays backend-agnostic exactly as it is today.
- **BFF as the single choke point**: no engine or user talks to loom-unity directly (IRC already enforces this — `iceberg-catalog-client.ts:29-36`); every call audited to Cosmos `_auditLog` + `LoomAudit_CL` (audit-stream), which *is* the Gov "system.access.audit".

### 4.3 Enforcement points (engines)
| Engine | Attach | Enforcement |
|---|---|---|
| Synapse serverless SQL | External tables/views over the same ADLS Delta | Compiled GRANTs + **secure views** for row filters/masks (rls-compiler reuse) |
| Synapse Spark | UC OSS connector / IRC | Credential vending (READ/READ_WRITE) + view layer for ABAC |
| Trino (N7e opt-in) | Iceberg REST catalog (`/api/catalog/iceberg/*`) | Trino file/OPA access control generated from the same policy-code set |
| DuckDB | `uc_catalog`/IRC via BFF token | Scoped Loom API token + vended SAS; secure-view emit |
| RisingWave (N7a) | sinks to ADLS Delta registered in UC | write-path registration only |

Deny-by-default: engines get **vended, scoped, expiring credentials** (F10, built) rather than storage-wide RBAC.

### 4.4 Migration path from current catalog surfaces
1. `/catalog/unity` panes: already dual-backend — overlay data replaces the 501 gates tab-by-tab (tags → overlay; lineage → unified-lineage embed; audit → LoomAudit pane).
2. Governance catalog / Purview: register loom-unity tables into Purview via the existing `/api/catalog/register` route (identity join already normalizes the UC-in-Atlas qualifiedName — `unified-lineage.ts:81-84`).
3. Marketplace "Data shares": swap the Databricks 501 gate for the `loom-sharing` server endpoints; UI unchanged (`data-shares.tsx` route list).
4. Lakehouse items: `interop-pane.tsx` + shortcuts already reference UC/Delta-Sharing — point at Loom Unity endpoints.

### 4.5 Threat-model note per component
- **loom-unity server**: TODAY anonymous-in-VNet (authz disabled) — any compromised in-VNet workload can mutate the metastore or vend credentials. Mitigate: OIDC-vs-Entra + BFF-only ACA ingress restriction + audit on every call (LU-2). Postgres AAD-only removes the account-key/SMB surface.
- **Credential vending**: SP secret in container env (`LOOM_UNITY_ADLS_CLIENT_SECRET`) — move to KV secretref or workload-identity federation; vended SAS must stay short-TTL and scoped (upstream 0.5.1 fixed credential-caching bugs — bump).
- **delta-sharing server (new)**: bearer-profile tokens are long-lived secrets — prefer AAD-authenticated recipients; keep the server internal + publish through APIM with Entra validation; per-share audit rows; never expose activation URLs in logs (Loom already treats `activation_url` as surface-once, `unity-catalog-client.ts:1160-1167`).
- **ABAC compilers**: compiled artifacts are security controls — reconcile loop must be idempotent + drift-detected (compare deployed views/grants vs policy set; `policy-code/reconcile.ts` exists); injection-safety via the existing `bq`/`safeIdent` builders.
- **Overlay store (Cosmos)**: tags/certification are advisory metadata but ABAC policies are authoritative — partition per tenant, audit every mutation (audit-stream already covers admin choke points).
- **BFF proxy**: session/API-token auth then Entra bearer injection (IRC pattern) keeps the catalog unreachable and every access attributable — extend to all UC families.
- **Postgres**: private endpoint in-VNet, AAD-only (`no password auth`), PITR backups; single-region acceptable for Gov boundary.

---

## 5. Concrete phasing (M-sized items — the PRP flagship workstream)

| ID | Item | Size | Depends |
|---|---|---|---|
| LU-1 | **Postgres-by-default in Gov**: bicep flips `unityDbUrl` to a provisioned PG Flexible Server (AAD-only, PE), migration script, HA replicas>1; fix STALE-DOC #1 + bump image to 0.5.1 | M | — |
| LU-2 | **AuthN/Z hardening**: enable OSS UC OIDC vs Entra; BFF bearer injection (LOOM_UNITY_TOKEN path exists); ACA ingress restriction to Console; KV secretref for vending SP | M | LU-1 |
| LU-3 | **BFF audit choke point for all UC calls** → Cosmos `_auditLog` + `LoomAudit_CL`; "Loom Unity system tables" pane (audit/query-history over KQL) replacing the system-tables 501 gate | M | LU-2 |
| LU-4 | **Effective-permissions resolver** (inheritance walk over OSS grants) — removes the `effective-permissions` gate | M | — |
| LU-5 | **Governance overlay v1**: tags + governed tags + certification + attribute-group values on UC identities, surfaced in existing UC dialogs; Purview classification fold-in | M | — |
| LU-6 | **ABAC engine-compile v1 (Synapse)**: policy-code → secure views + GRANTs on Synapse serverless over the same Delta; reconcile + drift report; OSS `ucVariant` warning removed | M | LU-5 |
| LU-7 | **ABAC engine-compile v2 (Trino/DuckDB)**: OPA/file-based rules for Trino from the same set; DuckDB secure views | M | LU-6 |
| LU-8 | **OpenLineage ingest + emitters**: Synapse Spark/pipeline OL emitters → unified-lineage L2/L3; lineage tab on OSS backend shows the merged graph instead of a 501 | M | — |
| LU-9 | **loom-sharing (Delta Sharing server)**: OSS delta-sharing reference server ACA app over ADLS Delta; Marketplace Data-shares surface rewired; AAD recipients + APIM egress for cross-boundary | M/L | LU-2 |
| LU-10 | **Workspace bindings (Loom-native)**: workspace→catalog visibility bindings in Cosmos enforced at BFF listing/grant time; bindings dialog un-gated on OSS | M | LU-4 |
| LU-11 | **Foreign catalogs (read-only)**: Trino catalogs + Linked Services rendered as foreign catalogs in the Federation tab; register-through to Purview | M | LU-7 |
| LU-12 | **Semantic tier**: OSS metric views (0.5 experimental, Preview badge) + AI Search vector-index registration as overlay securables + Copilot NL2SQL over metric views (Genie parity) | M | LU-5 |

Ordering rationale: LU-1/2/3 make the Gov metastore production-trustworthy (security + audit first, per FedRAMP); LU-4/5 unlock the governance families the UI already gates on; LU-6..9 are the visible parity wins (ABAC, lineage, sharing); LU-10..12 finish the matrix.

---

## 6. Sources

Repo (primary): `apps/fiab-console/lib/azure/unity-catalog-client.ts`, `apps/fiab-console/lib/azure/uc-backend.ts`, `platform/fiab/bicep/modules/compute/loom-unity-app.bicep`, `docs/fiab/unity-gov.md`, `apps/fiab-console/lib/azure/iceberg-catalog-client.ts`, `platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep`, `apps/fiab-console/lib/governance/policy-code/compilers/unity-catalog.ts`, `apps/fiab-console/lib/azure/unified-lineage.ts`, `apps/fiab-console/lib/admin/audit-stream.ts`, `apps/fiab-console/app/api/external-shares/route.ts`, `apps/fiab-console/lib/components/marketplace/data-shares.tsx`, `apps/fiab-console/lib/panes/uc-security-panel.tsx`, `apps/fiab-console/lib/types/attribute-groups.ts`, `apps/fiab-console/lib/governance/label-policy-library.ts`, `apps/loom-unity/`.

Web (2026-07-24): [unitycatalog/unitycatalog](https://github.com/unitycatalog/unitycatalog) (Apache-2.0; README feature list), [Releases — v0.5.1](https://github.com/unitycatalog/unitycatalog/releases), [roadmap.md](https://github.com/unitycatalog/unitycatalog/blob/main/roadmap.md) (Delta Sharing/lineage/ABAC/federation/RBAC = ❓; metric views 🛠 v0.5; managed Delta done), [Databricks ABAC policies](https://docs.databricks.com/aws/en/data-governance/unity-catalog/abac/policies), [Row filters & column masks](https://docs.databricks.com/aws/en/data-governance/unity-catalog/filters-and-masks/), [ABAC GA announcement](https://community.databricks.com/t5/announcements/unity-catalog-new-abac-amp-data-classification-tools-now-ga/td-p/157231), [ABAC view-evaluation change](https://kb.databricks.com/upcoming-change-to-abac-policy-evaluation-for-tables-accessed-through-views-and-functions), [Securable objects reference](https://docs.databricks.com/aws/en/data-governance/unity-catalog/securable-objects), [Catalog federation](https://docs.databricks.com/aws/en/query-federation/catalog-federation), [Tags](https://docs.databricks.com/aws/en/database-objects/tags), [Certification](https://docs.databricks.com/aws/en/data-governance/unity-catalog/certify-deprecate-data), [Metric views](https://docs.databricks.com/aws/en/uc-semantics/metric-views), [Genie](https://docs.databricks.com/aws/en/genie/), [Vector/AI Search as UC table type](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/vector-search), [SCIM/identity federation](https://docs.databricks.com/aws/en/admin/users-groups/scim), [ABAC core concepts (Learn)](https://learn.microsoft.com/en-us/azure/databricks/data-governance/unity-catalog/abac/core-concepts).
