# PRP: Per-workspace Spark compute identity

| Field | Value |
|---|---|
| Status | DRAFT — design approved with defaults; only W0 (spike) may start |
| Created | 2026-09-30 |
| Decision source | Operator decision 2026-09-30 "Per-workspace identity" |
| Related rules | `.claude/rules/cloud-parity.md`, `.claude/rules/auto-bind-by-default.md`, `.claude/rules/deploy-integrity.md` |
| Related programs | Workspace identity program I1-I9 (`LOOM_WORKSPACE_IDENTITY_MODE`, `docs/fiab/runbooks/workspace-identity-{grants,migration}.md`) |
| Boundaries | Commercial (incl. tenant-DMLZ), GCC, GCC-High, IL5 |

## 0. Summary

The goal is least-privilege hardening: each workspace's compute runs with an identity scoped to that workspace's storage.

Today, every Spark workload the console drives shares one platform submitter identity and one Synapse workspace managed identity. Both hold data roles at storage-account scope. The workloads are notebook runs, transform preview, load-to-table, table stats, maintenance, schema DDL, interop, and scheduled or taskflow launches.

This PRP moves those workloads to a per-workspace user-assigned managed identity (`uami-ws-<workspaceId>`). That identity holds data-plane grants only on the lakehouse roots owned by its workspace. It is provisioned and bound automatically when a workspace or lakehouse is created, and it repairs itself on drift. No data moves.

**Recommendation: option (b).**
- Keep the shared Synapse Spark pools.
- Submit interactive Livy sessions as the per-workspace UAMI, so Synapse's Entra passthrough to ADLS runs as that identity.
- Scope storage with path-conditioned role assignments (ABAC) on each lakehouse root. Use POSIX ACLs in any boundary where ABAC on storage is not confirmed available.
- Keep platform-owned, fixed-code batch jobs on the Synapse workspace MSI. Move batches that carry user code onto per-workspace sessions.
- Narrow the shared grants last.

Option (a), a per-workspace UAMI on the Spark session or a pool per workspace, is not supported by Synapse at the session level. A pool per workspace does not change the identity. Option (c), Databricks Unity Catalog, is not available in GCC-High or IL5, so it cannot meet cloud parity. It stays a possible Commercial-only additive lane.

## 1. Goals and non-goals

### Goals
- G1. Every workspace-scoped Spark job runs with an identity whose storage grants cover only that workspace's lakehouse roots. This covers session, statement and batch jobs, on every path in section 2.1.
- G2. Workspace create and lakehouse create provision and bind the identity and its grants. A reconciler repairs drift (auto-bind).
- G3. Parity across Commercial, GCC, GCC-High and IL5. The same mechanism is used everywhere, or a documented equivalent with the same guarantee.
- G4. No data movement. Existing roots keep their paths.
- G5. Every stage can be reversed with a flag or a parameter.

### Non-goals
- BFF-side (non-Spark) ADLS access by the console. That belongs to the WS-I program (I1-I9).
- Isolating the Spark catalog (the Hive metastore is per Synapse workspace). Deferred by decision Q10 (section 10).
- Dedicated SQL pool and serverless SQL identity.

## 2. Inventory (measured on origin/main, 2026-09-30)

Route paths are relative to `apps/fiab-console/app/api/`. Each path ends in `/route.ts`.

"Submitter" is the identity that calls the Synapse dev endpoint (Livy API). Every call site gets its token from the shared console credential chain, which is built at module level in `lib/azure/synapse-dev-client.ts`.

"Storage identity" is the identity Spark uses for ADLS I/O:
- Interactive sessions use Entra passthrough as the submitter.
- Batch jobs use the Synapse workspace MSI.

Both are to be measured in W0 (section 3).

### 2.1 Spark / Livy submit paths

| # | Call site (file:line) | Client function | Mode | Submitter | Storage identity (expected) | Class |
|---|---|---|---|---|---|---|
| 1 | `items/notebook/[id]/run:350` (preambles 382, 400, 415; root resolution 53-65) | `createLivySessionAsync` + statements | session | Console UAMI | Console UAMI (passthrough) | U (user code) |
| 2 | `items/notebook/[id]/runs/[runId]:301,308,312,482` | session/statement polling and submit | session | Console UAMI | Console UAMI | U |
| 3 | `items/notebook/[id]/execute-spark:149,246` | session + statement | session | Console UAMI | Console UAMI | U |
| 4 | `notebook/[id]/execute:204` | statement | session | Console UAMI | Console UAMI | U |
| 5 | `notebook/[id]/session:182` | session create | session | Console UAMI | Console UAMI | U |
| 6 | `synapse/notebooks/[name]/run-cell:119,135` | session + statement | session | Console UAMI | Console UAMI | U |
| 7 | `copilot/code-interpret:148,176` | session + statement | session | Console UAMI | Console UAMI | U |
| 8 | `ml-model/[id]/predict:338`, `predict/status:130` | session/statement | session | Console UAMI | Console UAMI | U |
| 9 | `spark-environment/[id]/validate:98,136` | session + statement | session | Console UAMI | Console UAMI | U |
| 10 | `items/spark-job-definition/[id]/submit:98` | `submitSparkBatchJob` | batch | Console UAMI | Synapse workspace MSI | U |
| 11 | `items/synapse-spark-pool/[id]/submit:21` | batch submit | batch | Console UAMI | Synapse workspace MSI | U |
| 12 | `synapse/sparkjobdefinitions/[name]/run:80` | batch submit | batch | Console UAMI | Synapse workspace MSI | U |
| 13 | `lakehouse/transform-preview:173,179,248` | session + statement | session | Console UAMI | Console UAMI | W (fixed code, workspace data) |
| 14 | `lakehouse/table-stats:210,244,252` | session + statement | session | Console UAMI | Console UAMI | W |
| 15 | `lakehouse/load-to-table:160` | `submitLivyBatch` | batch | Console UAMI | Synapse workspace MSI | W |
| 16 | `lakehouse/maintenance:100,170` | session/statement | session | Console UAMI | Console UAMI | W |
| 17 | `lakehouse/schemas:120,157,199` | `runSparkSqlAndWait` | session | Console UAMI | Console UAMI | W |
| 18 | `lakehouse/interop:222` | session/statement | session | Console UAMI | Console UAMI | W |
| 19 | `lib/azure/materialized-lake-view-engine.ts:145` | session/statement | session | Console UAMI | Console UAMI | W |
| 20 | `lib/scheduler/run-adapters.ts:156,175` | session/batch dispatch | both | Console UAMI | per mode | W/U (by item type) |
| 21 | `lib/taskflow/launch-item.ts:201,218` | session/batch dispatch | both | Console UAMI | per mode | W/U (by item type) |
| 22 | `lib/migrate/copy-engine.ts:1085` | `submitLivyBatch` | batch | Console UAMI | Synapse workspace MSI | W |
| 23 | `lib/azure/mirror-engine.ts:1536` | session/statement | session | Console UAMI | Console UAMI | W (platform-driven, per item) |
| 24 | `lib/azure/mirror-cdf-producer.ts:257` | session/statement | session | Console UAMI | Console UAMI | W |
| 25 | `lib/azure/spark-session-pool.ts:685` | warm session pool | session | Console UAMI | Console UAMI | P (shared warm pool) |
| 26 | `lib/admin/service-probes.ts:138,160` | probe session | session | Console UAMI | Console UAMI | P (platform health) |
| 27 | `lib/apps/supercharge-seed.ts:282,298` | seed session | session | Console UAMI | Console UAMI | P/W |

**Classes:**
- **U:** runs user-authored code.
- **W:** runs fixed platform code against one workspace's data.
- **P:** platform-level, with no single-workspace context.

### 2.2 Client layer

| File:line | Export | Notes |
|---|---|---|
| `lib/azure/synapse-dev-client.ts:88` | Livy base path | `https://{ws}.{LOOM_SYNAPSE_DEV_SUFFIX}/livyApi/versions/2019-11-01-preview/sparkPools/{pool}/...` |
| `lib/azure/synapse-dev-client.ts:513` | `submitSparkBatchJob` | batch |
| `lib/azure/synapse-dev-client.ts:984` | `submitLivyBatch` | batch |
| `lib/azure/synapse-dev-client.ts:1077` | `createLivySessionAsync(pool, kind, conf?, sizing?)` | session; no credential parameter today |
| `lib/azure/synapse-dev-client.ts:1133` | `submitLivyStatement` | statement |
| `lib/azure/synapse-dev-client.ts:1152` | `runSparkSqlAndWait` | session + statement helper |
| `lib/azure/synapse-livy-client.ts:72,185,497` | legacy Livy helpers | same credential chain |

None of these functions accepts a credential or a workspace context today. Section 6 and W2 add one.

### 2.3 abfss builders (parity consistency)

The canonical builder is `lib/azure/lakehouse-abfss.ts`:
- `dfsSuffix()` import at 108.
- `resolveLakehouseAbfss` at 430.
- Root-owner helpers: `readLakehouseRootOwner` 171, `createOwnedLakehouseRoot` 198, `stampLakehouseRootOwner` 217, `mayAdoptRoot` 245, `listLakehouseRootFacts` 257.

These sites build DFS hostnames with the Commercial suffix directly and should be routed through the canonical builder:

| File:line | Pattern |
|---|---|
| `lakehouse/transform-preview:66-67` | regex on `.dfs.core.windows.net`, falls back to https URL |
| `lakehouse/table-stats:64-67` | same |
| `lib/azure/delta-maintenance.ts:135` | literal suffix |
| `lakehouse/settings:138,273` | literal suffix |
| `items/spark-job-definition/[id]/files:61` | literal suffix |
| `lakehouse/upload:111` | literal suffix |

### 2.4 Lakehouse root layout

- Roots are directories inside the shared medallion containers of one DLZ storage account. The containers are `bronze`, `silver`, `gold`, `landing` and `csv-imports` (`lib/azure/adls-client.ts:40`, `KNOWN_CONTAINERS`).
- Items created after `LAKEHOUSE_ITEM_ROOT_SINCE = 2026-09-29T00:00:00Z` use `lakehouses/<name>--<itemId>`. Older items use `lakehouses/<name>`.
- The owner marker is the directory metadata key `loomitemid`.
- Because the roots of every workspace share the same containers, container-scope RBAC cannot express "this workspace's roots". Scoping has to be by path, using an ABAC path condition or a directory ACL.

### 2.5 Identities and storage grants (bicep)

| Principal | Role | Scope | Source |
|---|---|---|---|
| Synapse workspace system MSI | Storage Blob Data Contributor (`ba92f5b4-...`) | DLZ storage account | `landing-zone/synapse-storage-rbac.bicep` (`grant`), wired at `landing-zone/synapse.bicep:401-410` |
| Console UAMI | Storage Blob Data Reader (`2a2b9908-...`) | DLZ storage account | `synapse-storage-rbac.bicep` (`consoleReaderGrant`) |
| Console UAMI | Storage Blob Data Contributor (`consolePrincipalNeedsContributor`, default true) | DLZ storage account | `synapse-storage-rbac.bicep` (`consoleContributorGrant`) |
| Console UAMI | Storage Blob Data Owner (only if `consolePrincipalNeedsOwner`) | DLZ storage account | `synapse-storage-rbac.bicep` (`consoleOwnerGrant`) |
| Console UAMI | Role Based Access Control Administrator (`f58310d9-...`), ABAC-constrained to Blob Data Reader/Contributor/Owner assignments | DLZ storage account | `landing-zone/storage-rbac-admin.bicep` (`blobOnlyCondition`) |
| ADX MI | Storage Blob Data Reader | DLZ storage account | `synapse-storage-rbac.bicep` (`adxReaderGrant`) |
| Databricks Access Connector MI | Storage Blob Data Contributor | DLZ storage account | `landing-zone/databricks-storage-rbac.bicep` (empty in GCC-High/IL5) |
| Console UAMI | Synapse Compute Operator | `workspaces/<ws>/bigDataPools/loompool` | `synapse.bicep:553-585` (`consoleSparkSubmitRoleScript`, deploymentScript, failure-tolerant) |
| Console UAMI | Synapse Artifact Publisher / SQL admin / ARM Contributor | Synapse workspace | `synapse.bicep:606`, `:684`, `:371` |
| `uami-ws-<id>` (dormant) | container-scope Contributor + firewall rule, cap 200 | per container | `workspace-identity.bicep`, `workspace-identity-grants.bicep` |

The Console UAMI's constrained RBAC Administrator role already lets the BFF write path-conditioned Blob Data role assignments. The spark-lake backend (section 6) reuses it.

### 2.6 Synapse topology per boundary

`loomSynapseEnabled = true` in every boundary. It is set in the param files at: commercial:298, commercial-full:487, gcc:227, gcc-high:424, il5:497, tenant-dmlz:332.

| Item | Commercial / tenant-DMLZ | GCC | GCC-High | IL5 |
|---|---|---|---|---|
| Synapse workspace | one per DLZ: `syn-loom-<domain>-<region>` (`synapse.bicep:144-161`), SystemAssigned MSI, managed VNet, public network disabled, exfiltration protection on | same | same | same |
| Default ABFS | DLZ account, `defaultFileSystemName` | same | same | same |
| Spark pools | `loompool` (MemoryOptimized, Small, autoscale 3-10, autopause 15, Spark 3.4, `synapse.bicep:169-199`); `loometl` (Medium) and `loombatch` (Large) when `deploySparkWorkloadTiers` (`synapse-spark-pools.bicep:109-127`, `landing-zone/main.bicep:349`) | same | same | same (isolated compute per `sparkPoolIsolatedCompute`) |
| Dev endpoint suffix | `dev.azuresynapse.net` | `dev.azuresynapse.net` | Gov suffix via `LOOM_SYNAPSE_DEV_SUFFIX` | Gov suffix via `LOOM_SYNAPSE_DEV_SUFFIX` |
| Databricks UC / SQL Warehouse | available | available | not deployed (`gcc-high.bicepparam:150-151`) | not deployed (`il5.bicepparam:148-149`) |
| Exercise status | exercised | supported in code, not yet exercised | exercised (2026-09-01) | not yet exercised |

### 2.7 Existing per-workspace identity program (dormant)

- `lib/azure/workspace-credential-factory.ts` (I5) provides `credentialFor({ workspaceId, backend })`.
  - Modes: off, shadow, enforce.
  - LRU cache keyed on workspaceId.
  - `runWithWorkspaceContext` / `ambientWorkspaceId` via AsyncLocalStorage.
  - In enforce mode it falls back to the shared chain if the per-workspace credential is unavailable.
- `lib/azure/workspace-identity-client.ts:215-226` has `getWorkspaceCredential`, which returns `ManagedIdentityCredential({ clientId })`. This needs the UAMI to be attached to the hosting compute.
- `lib/azure/workspace-grants.ts` has `WORKSPACE_GRANTS` and `ensureWorkspaceGrants`. There is no Spark backend yet.
- `scripts/ci/check-workspace-credential-adoption.mjs` is the adoption ratchet.
- Mode defaults to off, and no param file sets `workspaceIdentityMode` (admin-plane `main.bicep:586`). Enforce requires I9 (threat model) and 2 weeks of clean shadow data.

## 3. Platform constraints (Microsoft Learn)

| Fact | Source |
|---|---|
| Spark access to primary storage uses Entra passthrough. Interactive notebooks run as the submitting identity by default, or as the workspace MSI ("Run as managed identity", which needs Synapse Compute Operator plus Synapse Credential User). | learn.microsoft.com/azure/synapse-analytics/synapse-service-identity |
| "Batch jobs and non-interactive executions of the notebook use the Workspace MSI." | same |
| The auth method of the default ABFS container cannot be changed. | learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-secure-credentials-with-tokenlibrary |
| Linked-service auth per account: account key (SAS provider), service principal, MI, credential. Selected with `spark.storage.synapse.<account>.linkedServiceName` and `LinkedServiceBasedTokenProvider`. | same |
| Notebooks and Spark job definitions support only the system-assigned MI through linked services and mssparkutils. UAMI is supported for notebook and SJD activities in pipelines. | same |
| Connecting to ADLS Gen2 with a UAMI from Spark pools is not supported. IMDS is not exposed in Spark pools. | Synapse Spark troubleshooting (credentials) |
| Workspace-level Spark vCore quota (support request per workspace); pool definition caps cores per user, and "each user gets its own instance of the pool". | learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-concepts |
| 50 running / 200 queued / 250 active jobs per pool; 1000 active jobs per workspace; create session and create batch are limited to 2 requests/s per workspace; Livy payload max 100 KB. | learn.microsoft.com/rest/api/synapse/concurrency-limits-spark-pools |
| ABAC is GA for Blob and ADLS Gen2 (resource/request attributes). Path conditions must also constrain rename (`blobs/move/action`) and, on HNS, `runAsSuperUser`. | learn.microsoft.com/azure/storage/blobs/storage-auth-abac, .../storage-auth-abac-security |
| ACLs are evaluated only when RBAC does not already grant access. Limit is 32 access plus 32 default entries per item (effectively 28). Default ACLs apply only to new children; `setAccessControlRecursive` is resumable and idempotent. | learn.microsoft.com/azure/storage/blobs/data-lake-storage-access-control-model |
| 4000 role assignments per subscription. | same |
| MI create 80 per 20 s per subscription per region and 400 per 20 s per tenant per region; assign 300 per 20 s; creation blocked near the tenant directory quota; soft delete 30 days. MI tokens are cached, so some permission changes can take hours to apply. | managed identities limits and best practice |

**Consequence:** Synapse cannot run a Spark session under a chosen UAMI. The per-workspace identity must either be the submitting identity of an interactive session (passthrough), or be the system MSI of a separate Synapse workspace.

## 4. Options

### (a) A per-workspace UAMI on the session, or a Spark pool per workspace

- **(a1) Session-level UAMI.** Not supported (section 3). Rejected.
- **(a2) A pool per workspace in the shared Synapse workspace.** A pool has no identity of its own, and the MSI belongs to the Synapse workspace. This isolates compute but not identity, so it does not meet G1. It could be an optional compute tier later (Q5).
- **(a3) A Synapse workspace per Loom workspace.** Its system MSI is the per-workspace identity.

| Dimension | (a3) |
|---|---|
| Cost | Per Loom workspace: a managed VNet, managed private endpoints to DLZ dfs/blob (plus Key Vault if used), hub private endpoints for Dev and SqlOnDemand, and private DNS records. Spark is billed only while running, but the per-workspace networking footprint is fixed cost. |
| Latency | Provisioning a managed-VNet Synapse workspace takes tens of minutes (estimate, to be measured). Every workspace cold-starts its own pools. There is no cross-workspace warm session reuse. |
| Quota | The vCore quota is per Synapse workspace, so it needs a quota request per workspace. Subscription resource and private-endpoint counts grow linearly. |
| Gov | Synapse is available in GCC-High and IL5. The quota process is manual in each. |
| Parity | Yes, but costly. |
| Verdict | Not recommended as the default. It could be an opt-in "dedicated" tier. |

### (b) Shared pools, per-workspace submitter identity, path-scoped storage grants (recommended)

- Keep the shared pools (`loompool`, `loometl`, `loombatch`).
- **Interactive sessions.** The BFF gets a Synapse dev-endpoint token as `uami-ws-<id>` and creates the Livy session with it. Passthrough then does all Spark ADLS I/O in that session as `uami-ws-<id>`.
- **Storage scoping, (b1) ABAC.** Grant Storage Blob Data Contributor on the DLZ account to `uami-ws-<id>` with a condition that ORs `(container, path)` pairs for each root the workspace owns:
  - `@Resource[...containers:name] StringEquals '<c>' AND (@Resource[...blobs:path] StringEquals '<root>' OR StringStartsWith '<root>/')`
  - `@Request[...blobs:prefix]` for List.
  - The same restriction on the rename destination and on `runAsSuperUser`.
  - The trailing `/` keeps a legacy `lakehouses/<name>` prefix from also matching `lakehouses/<name>--<id>` or `lakehouses/<name>2`.
  - The BFF writes the assignment through its existing constrained RBAC Administrator role (`storage-rbac-admin.bicep`).
- **Storage scoping, (b2) ACLs**, the fallback where ABAC is unconfirmed:
  - Put `rwx` access and default entries for `uami-ws-<id>` on each root, applied recursively.
  - Traversal (`--x`) on each ancestor (container root, `lakehouses/`) goes to one security group, `loom-spark-traverse`, rather than to each identity, to stay under the 28-entry limit.
  - ACLs only take effect for a principal that has no account- or container-scope data role, and `uami-ws-*` gets none on this lane.
- **Batches.** Batch jobs run as the workspace MSI (section 3). Class U batches (rows 10-12) and class W batches (rows 15, 22) move to sessions submitted as the workspace UAMI. The alternative is pipeline notebook/SJD activities with a UAMI credential (Q3). Class P stays on the MSI.
- **Synapse RBAC.** `uami-ws-<id>` gets Synapse Compute Operator on each Loom pool.
- **Shared grants.** These are narrowed only after enforce is proven: Console UAMI and Synapse MSI data roles move from account scope to platform paths (section 7, phase 4).

| Dimension | (b) |
|---|---|
| Cost | No new compute. One UAMI per workspace (free). About 1 storage role assignment per workspace plus 1 Synapse role assignment per pool. |
| Latency | Same Spark start time as today. The warm session pool (`spark-session-pool.ts:685`) becomes keyed by workspace, so warm hits are rarer for low-traffic workspaces. A grant rewrite on lakehouse create adds one ARM write (throttled 600 ms by `queuedArmWrite`). |
| Quota | Pool caps apply per user, and each submitter gets its own pool instance. Per-workspace submitters therefore raise peak concurrent vCores against the Synapse workspace quota compared with one shared submitter. The 2/s create-session limit per Synapse workspace is unchanged and shared. Role assignments stay far below 4000 per subscription for the 200-workspace cap. |
| Gov | Synapse passthrough is available in all boundaries. ABAC on storage is GA, but Gov availability must be confirmed per boundary (Q1). ACLs (b2) are a core ADLS feature available in all boundaries. |
| Parity | Yes, with the ABAC-or-ACL switch per boundary behind one interface. |
| Verdict | **Recommended.** |

### (c) Databricks Unity Catalog scoped credentials

Unity Catalog would use a storage credential and an external location per workspace root, with grants to a per-workspace principal.

| Dimension | (c) |
|---|---|
| Cost | Databricks compute and SQL warehouses on top of Synapse. |
| Latency | Cluster start time is comparable. |
| Quota | Databricks workspace limits. |
| Gov | Not deployed in GCC-High or IL5 (param files). |
| Parity | **No.** Fails `cloud-parity.md` as the primary mechanism. |
| Verdict | Not selected. It could be an additive lane for items that already run on Databricks in Commercial (Q7). |

## 5. Recommendation

Adopt (b):
- Per-workspace UAMI as the session submitter.
- Path-scoped storage grants: ABAC where confirmed, ACLs elsewhere, behind one `SparkLakeScoper` interface.
- Batches carrying user code converted to per-workspace sessions.
- Platform batches stay on the Synapse MSI with narrowed scope.

W0 measures the passthrough behaviour before any other work item starts.

## 6. Auto-bind and self-heal

This follows `auto-bind-by-default.md`.

1. **Workspace create.** `ensureWorkspaceGrants(ws, ['spark-lake'])` runs as part of the existing create flow:
   - It ensures `uami-ws-<id>` exists (existing I-program).
   - It grants Synapse Compute Operator on each deployed Loom pool.
   - It writes the storage scope for the workspace's roots. The first grant for a new workspace has no roots, so it either holds a condition that matches nothing or is created lazily when the first lakehouse is created.
   - It records a binding in `workspace-bindings` with a fingerprint: the hash of `{uamiPrincipalId, pools, sorted roots, scoper kind}`.
2. **Lakehouse create, delete or adopt** (`createOwnedLakehouseRoot`, `mayAdoptRoot`). The workspace's root set is recomputed from `listLakehouseRootFacts` plus the item store. Then:
   - ABAC: the condition is rewritten with an idempotent PUT on a deterministic assignment GUID.
   - ACLs: the entries are applied to the new root.
3. **Self-heal.**
   - A reconciler runs on the admin env-check, on a schedule, and lazily on the first Spark submit when the binding is missing or stale. It compares the expected fingerprint against the actual assignment or ACL state and repairs any drift.
   - In enforce mode, a Spark submit whose binding cannot be healed returns an actionable status (`spark-identity-binding-pending`, with a retry and an admin link). Per decision Q4, this lane does not fall back to the shared identity.
4. **Admin surface.** Extend `admin/workspaces/[id]/identity` and `workspace-identity-panel.tsx` to show:
   - the spark-lake binding state;
   - the scoper kind (ABAC or ACL);
   - the root count;
   - the last heal time;
   - a "Re-bind" action.

   The env-check gets a row per boundary.
5. **Throttling.** All writes go through `queuedArmWrite` (600 ms spacing, 429 backoff). UAMI creation respects 80 per 20 s per subscription per region, and the brownfield backfill runs in batches under that.

## 7. Migration (no data movement)

| Phase | Action | Reversible by |
|---|---|---|
| 0. Prep | Route all abfss building through `resolveLakehouseAbfss` / `dfsSuffix()`. Spark routes resolve the root from the item ID, so each submit carries a workspace ID. Add the credential and workspace parameters to the client layer. No identity change. | revert PR |
| 1. Provision | Backfill `uami-ws-<id>`, Synapse Compute Operator and the spark-lake storage scope for every existing workspace. This is additive; existing account-scope grants stay. ACL mode applies recursively per root (resumable, idempotent). | delete the per-workspace assignments; ACL entries can stay |
| 2. Shadow | `LOOM_SPARK_IDENTITY_MODE=shadow`. Submissions stay on the shared identity. For every submit, the evaluator checks whether each resolved abfss path falls inside the workspace's scoped roots and logs any mismatch through the I3 shadow hook. Exit gate: 14 days with no unexplained mismatches per boundary. | set mode off |
| 3. Enforce | Enforce per workspace via an allowlist, in this order: class U sessions, then class W sessions, then converted batches. Boundary order: Commercial/DMLZ, then GCC, then GCC-High, then IL5 (Q8). | remove the workspace from the allowlist; new sessions use the shared identity again and running sessions finish under their current identity |
| 4. Narrow | New bicep parameters, `synapseMsiStorageScope` and `consoleSparkStorageScope` with values `account` or `platform-paths`. They narrow the Synapse MSI and the console's Spark-lane data roles to the platform paths (default filesystem, warehouse, and mirror staging as measured in W0). This happens only after phase 3 has completed everywhere in that boundary. | redeploy with `account` |

**Rollback timing.** Role assignment changes can take a while to propagate, and managed identity tokens are cached. Plan rollback windows in hours, not minutes. Phase 3 rollback is immediate for new sessions because it changes the submitter, not a grant.

## 8. Work items

Every work item lists its owned files, its gates, and the receipts `deploy-integrity.md` requires per boundary: Commercial (including tenant-DMLZ), GCC, GCC-High and IL5, for both greenfield and brownfield. A boundary with no deployment records `not-exercised` explicitly, not a pass.

| ID | Work | Owned files | Gates |
|---|---|---|---|
| W0 | **Spike.** (1) Confirm passthrough uses the Livy submitter's identity for sessions created by a managed identity. (2) Confirm the storage identity for batches. (3) List the default-filesystem paths a session touches (staging, event logs, warehouse, libraries). (4) ABAC condition size with 50 roots. (5) Rename and `runAsSuperUser` behaviour under the condition. (6) ABAC availability in GCC-High and IL5. (7) Recursive ACL throughput per 10k files. (8) Token audience for the Gov dev endpoint. (9) User-assigned identity attachment limits on the submitter host chosen in Q2. | `docs/fiab/spikes/spark-identity-w0.md` (evidence only) | measurements recorded per boundary; go/no-go on (b1) vs (b2) |
| W1 | abfss builder consolidation (section 2.3) | the six files in 2.3, `lib/azure/lakehouse-abfss.ts` | new ratchet `scripts/ci/check-abfss-builder.mjs` (no literal DFS suffix outside the builder); unit tests for Gov suffix |
| W2 | Client layer takes an explicit credential and workspace context | `lib/azure/synapse-dev-client.ts`, `lib/azure/synapse-livy-client.ts` | typecheck; ratchet `scripts/ci/check-spark-submit-identity.mjs` (every call site in 2.1 passes a workspace context or is tagged `platform`) |
| W3 | Route-level root resolution from the item ID for class W routes | `lakehouse/{transform-preview,table-stats,load-to-table,maintenance,schemas,interop}` | route tests; item-to-workspace binding asserted |
| W4 | Token source for `uami-ws-<id>`, per Q2 | `lib/azure/workspace-identity-client.ts`, `lib/azure/workspace-credential-factory.ts`, infra for the selected host | token obtained for the dev-endpoint audience in each boundary |
| W5 | `spark-lake` backend: `SparkLakeScoper` with an ABAC and an ACL implementation | `lib/azure/workspace-grants.ts`, new `lib/azure/spark-lake-scoper.ts` | unit tests for condition generation (trailing-slash, legacy roots, rename, superuser); idempotent PUT |
| W6 | Synapse RBAC per workspace (Compute Operator on each pool) | `lib/azure/workspace-grants.ts`; bicep for the console's Synapse RBAC-write authority (Q9) | assignment visible via the Synapse RBAC API |
| W7 | Auto-bind hooks (workspace create, lakehouse create/delete/adopt) and the reconciler | workspace create flow, `lib/azure/lakehouse-abfss.ts` hooks, `lib/azure/workspace-bindings.ts` | e2e: a new workspace and lakehouse are bound without admin action; drift injected and repaired |
| W8 | Per-workspace warm session pool keying | `lib/azure/spark-session-pool.ts` | no cross-workspace session reuse (unit test); warm hit rate reported |
| W9 | Batch conversion (rows 10-12, 15, 22) per Q3 | the listed routes, `lib/migrate/copy-engine.ts`, `lib/scheduler/run-adapters.ts`, `lib/taskflow/launch-item.ts` | parity tests of old vs new output |
| W10 | Shadow evaluator and mode flag `LOOM_SPARK_IDENTITY_MODE` | `lib/azure/workspace-identity-shadow.ts`, admin env-check | 14-day clean shadow per boundary |
| W11 | Admin UI and runbook | `workspace-identity-panel.tsx`, `admin/workspaces/[id]/identity`, `docs/fiab/runbooks/workspace-identity-grants.md` | UI shows the binding, scoper kind and heal action |
| W12 | Narrowing parameters (phase 4) | `landing-zone/synapse-storage-rbac.bicep`, `landing-zone/synapse.bicep`, param files | what-if shows only the intended assignment changes; rollback redeploy rehearsed |

### Receipts per boundary (greenfield and brownfield)

Each receipt records:
- the deployment name and correlation ID;
- the what-if output for the bicep changes;
- the env-check JSON, with the spark-lane binding row;
- a scope verification Spark probe, submitted as the workspace identity:
  - read and write inside the workspace's root succeed;
  - access outside the workspace's assigned roots returns 403;
- the shadow report summary;
- for brownfield, the backfill count and time and the recursive ACL count (ACL mode).

| Boundary | Greenfield | Brownfield |
|---|---|---|
| Commercial / DMLZ | required | required |
| GCC | required (first exercise) | required |
| GCC-High | required | required |
| IL5 | required (first exercise) | required |

## 9. Risks

| Risk | Mitigation |
|---|---|
| Passthrough behaves differently from the docs for MI-submitted Livy sessions | W0 gate before W2 onwards |
| Session code writes outside the root (for example `saveAsTable` into the default warehouse) | W0 measures the paths; routes use path-based tables; the default-filesystem allowance is limited to what W0 measures |
| Higher peak vCore use (per-user pool instances) | quota request per boundary before enforce; per-workspace session caps |
| Create-session limit (2/s per Synapse workspace) | the existing retry and backoff; warm pool per workspace |
| ABAC condition length as a workspace's roots grow | W0 measures; split into multiple assignments per container if needed |
| ACL traversal entries at ancestors | one traverse group; group membership delay only affects ancestor traversal |
| Assignment and token propagation delay | rollback windows planned in hours; phase 3 rollback switches the submitter, not grants |
| UAMI or directory-object quota | cap of 200 workspaces (existing); batched backfill |
| Hosting limits on attached user-assigned identities | decision Q2 (separate submitter host); attachment limits measured in W0 |
| Spark catalog (metastore) remains shared per Synapse workspace | Q10 |

## 10. Decisions (operator, 2026-09-30: accept the recommended defaults)

Each decision gates the work item(s) named in brackets.

| Q | Decision | Option chosen |
|---|---|---|
| Q1 | C | Storage scoping: ABAC where confirmed available per boundary, ACL fallback elsewhere, behind one `SparkLakeScoper` interface. [W0, W5] |
| Q2 | B | Token source: a separate Spark-submitter container app/job holds the per-workspace identities, pending the attachment limits measured in W0. [W0, W4] |
| Q3 | C | Batches: user-code (class U) and workspace-data (class W) batches become per-workspace sessions; platform fixed-code batches stay on the Synapse MSI. [W9] |
| Q4 | A | Unhealable binding in enforce: fail with an actionable status, no fallback to the shared identity. [W7] |
| Q5 | A | Dedicated compute: no per-workspace pools for now. [none] |
| Q6 | A | Legacy roots: scope `lakehouses/<name>` roots by `name/` prefix with a trailing slash. [W5] |
| Q7 | A | Databricks Unity Catalog: out of scope for this PRP. [none] |
| Q8 | A | Enforce order: Commercial/DMLZ, then GCC, then GCC-High, then IL5. [phase 3] |
| Q9 | B | Synapse RBAC write authority: deploy-time script loop plus the reconciler. [W6, W7] |
| Q10 | A | Spark catalog: accept the shared per-Synapse-workspace metastore for now; a follow-up PRP addresses it later. [none] |

## 11. References

- learn.microsoft.com/azure/synapse-analytics/synapse-service-identity
- learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-secure-credentials-with-tokenlibrary
- learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-concepts
- learn.microsoft.com/rest/api/synapse/concurrency-limits-spark-pools
- learn.microsoft.com/azure/storage/blobs/storage-auth-abac
- learn.microsoft.com/azure/storage/blobs/storage-auth-abac-security
- learn.microsoft.com/azure/storage/blobs/data-lake-storage-access-control-model
- learn.microsoft.com/entra/identity/managed-identities-azure-resources/managed-identities-faq (limits)
