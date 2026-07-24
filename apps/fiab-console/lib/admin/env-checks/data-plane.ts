/**
 * R30 fragment — the 'data-plane' domain slice of ENV_CHECKS (formerly part of the
 * lib/admin/env-checks.ts monolith). An env-adding item edits ONLY its own
 * domain fragment; ./index.ts merges every fragment into the same exported
 * ENV_CHECKS array (public API unchanged). Import ONLY from './core' here —
 * never './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const DATA_PLANE_ENV_CHECKS: EnvSpec[] = [
  // ── data-plane (Cosmos = the Loom store; required to run at all) ──
  {
    id: 'cosmos-config', category: 'data-plane', title: 'Cosmos DB (Loom store)', severity: 'critical',
    anyOf: [['LOOM_COSMOS_ENDPOINT', 'COSMOS_ENDPOINT']],
    remediation: 'Set LOOM_COSMOS_ENDPOINT (and LOOM_COSMOS_DATABASE) — Cosmos holds every workspace, item, permission grant, and config. Loom cannot run without it.',
    docs: 'https://learn.microsoft.com/azure/cosmos-db/',
    provisionedBy: 'modules/landing-zone/main.bicep (cosmos account) → admin-plane forwards loomCosmosAccount → apps[] env',
    role: 'Cosmos DB Built-in Data Contributor (UAMI, assigned via CLI/ARM)',
  },
  {
    id: 'subscription', category: 'data-plane', title: 'Azure subscription + resource groups', severity: 'critical',
    required: ['LOOM_SUBSCRIPTION_ID'],
    anyOf: [['LOOM_DLZ_RG', 'LOOM_ADMIN_RG']],
    remediation: 'Set LOOM_SUBSCRIPTION_ID and at least one of LOOM_DLZ_RG / LOOM_ADMIN_RG so ARM discovery + scaling can target the deployment.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env, auto-derived from deployment scope)',
  },
  // ── Hyperscale band (HYP-16) — the three optional H-band substrate services.
  //    Each is default-OFF/opt-out: unset → the console lib client honest-503
  //    gates and SILENTLY falls back to the existing path (no Fabric gate, no
  //    regression). Deploy compute/hband-shared.bicep (shared Redis + UAMIs) then
  //    the per-service compute/loom-*-app.bicep, and set these on the Console app.
  {
    id: 'svc-loom-onelake', category: 'data-plane', title: 'Loom OneLake — unified namespace service (Hyperscale)', severity: 'optional',
    required: ['LOOM_ONELAKE_URL'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_ONELAKE_URL to the internal-ingress Loom OneLake ACA app (loom://<workspace>/<item>.<type>/<path> namespace + shortcut + security + catalog resolver on ADLS Gen2 + Cosmos — no Microsoft Fabric / OneLake DNS). Deploy compute/loom-onelake-app.bicep on the shared substrate from compute/hband-shared.bicep. Unset → the lakehouse/shortcut/security editors use the existing per-item library path (adls-client / lakehouse-shortcuts / onelake-security-client) with no loss of function.',
    provisionedBy: 'modules/compute/hband-shared.bicep (shared UAMIs + Redis) + modules/compute/loom-onelake-app.bicep (out-of-band; admin-plane at 256-param ceiling) → LOOM_ONELAKE_URL on the Console app',
    role: 'Storage Blob Data Contributor (uami-loom-onelake) on the DLZ lake + Cosmos data-plane on the registry containers',
  },
  {
    id: 'svc-loom-directlake', category: 'data-plane', title: 'Loom Direct Lake — columnar cache/scan engine (Hyperscale)', severity: 'optional',
    required: ['LOOM_DIRECTLAKE_URL'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_DIRECTLAKE_URL to the internal-ingress Loom Direct Lake ACA app (Arrow + delta-rs framing/transcoding + DuckDB/DataFusion scan; the OSS outcome-equivalent of Direct Lake — no VertiPaq, no Power BI). Also set LOOM_SEMANTIC_BACKEND=loom-columnar-cache to route DAX-class queries to it. Deploy compute/loom-directlake-app.bicep on compute/hband-shared.bicep. Unset → the semantic-model / report layer uses the AAS fast-path or the Synapse-Serverless cold path unchanged.',
    provisionedBy: 'modules/compute/hband-shared.bicep (uami-loom-directlake + shared Redis) + modules/compute/loom-directlake-app.bicep (out-of-band) → LOOM_DIRECTLAKE_URL on the Console app',
    role: 'Storage Blob Data Reader (uami-loom-directlake) on the DLZ lake; Redis Data Contributor on the shared cache (wired by hband-shared.bicep)',
  },
  // ── N2b — DuckDB serving tier (the interactive fast path BELOW Spark) ──
  {
    id: 'svc-loom-duckdb', category: 'data-plane', title: 'SQL Lab serving tier (embedded DuckDB Container App)', severity: 'optional',
    required: ['LOOM_DUCKDB_URL'], warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail:
      'SQL Lab is fully functional unset: the identical statement executes on Synapse Serverless and the status bar names the engine that answered. Deploying the DuckDB tier changes latency (sub-second cold start instead of a Serverless round-trip) and unlocks the Arrow transport that the in-browser Local analysis tab reuses — it never changes results.',
    remediation:
      'Set LOOM_DUCKDB_URL to the internal-ingress FQDN of the loom-duckdb Container App (embedded DuckDB with the azure/httpfs/delta/iceberg extensions, reading Delta/Iceberg/Parquet in place on the DLZ lake through its own managed identity). Deploy platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep, then set the var on the Console app. Optional knobs: LOOM_DUCKDB_MAX_ROWS (per-response row cap, default 200000) and LOOM_FLIGHT_ROW_THRESHOLD (rows past which Loom grids switch to the Arrow transport, default 5000). The tier is NEVER public — every query goes through the audited BFF at /api/duckdb/query.',
    docs: 'https://duckdb.org/docs/stable/core_extensions/delta',
    provisionedBy: 'modules/data-plane/duckdb-aca.bicep (out-of-band standalone entrypoint; admin-plane/main.bicep is at the 256-param ceiling) → LOOM_DUCKDB_URL on the Console app',
    role: 'Storage Blob Data Reader (uami-loom-duckdb) on the DLZ lake — declared in the module. The engine is read-only by construction; the Console UAMI needs no new role (the BFF proxies).',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'DuckDB is a single embedded OSS binary and its extensions are baked into the image at build time, so the tier runs disconnected in an IL5 / air-gapped enclave against in-boundary storage. No SaaS query service is in the path.',
    },
  },
  // ── N3 — Arrow Flight SQL serving wire (ADBC / JDBC clients) ──
  {
    id: 'svc-flight-sql', category: 'data-plane', title: 'Arrow Flight SQL wire (ADBC / JDBC serving)', severity: 'optional',
    required: ['LOOM_FLIGHTSQL_URL'], warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail:
      'The Connect tab renders fully unset: Loom still streams the identical Arrow RecordBatches over the audited HTTP tier once a result crosses the Arrow threshold, and the tab explains the endpoint state honestly instead of printing an unreachable address. Wiring the Flight wire removes one hop for external ADBC / JDBC clients.',
    remediation:
      'Set LOOM_FLIGHTSQL_URL to the Flight gRPC endpoint of the loom-duckdb Container App (grpc://<fqdn>:8815 — the same module deploys it, additionalPortMappings). Set LOOM_FLIGHTSQL_PUBLIC_URL as well when you publish an externally reachable listener, so the Connect tab can hand out a directly usable URI instead of explaining that the endpoint is in-VNet only. Set LOOM_FLIGHT_TICKET_SECRET (Key Vault secretRef, on BOTH the Console and the loom-duckdb app) so minted tickets are cryptographically verified rather than accepted on in-VNet trust.',
    docs: 'https://arrow.apache.org/docs/format/FlightSql.html',
    provisionedBy: 'modules/data-plane/duckdb-aca.bicep (flightEnabled, default true) → LOOM_FLIGHTSQL_URL on the Console app',
    role: 'No extra Azure role. Access is a short-lived, Entra-scoped ticket minted by the audited BFF (/api/flightsql/session) and verified by the serving tier.',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'gRPC/HTTP2 on Container Apps is available in Commercial and Gov; in IL5 the wire stays internal-ingress and tickets are minted in-boundary by this console, so the capability runs disconnected.',
    },
  },
  // ── N1 — Iceberg REST Catalog (the zero-copy external-engine bridge) ──
  {
    id: 'svc-iceberg-catalog', category: 'data-plane', title: 'Iceberg REST Catalog (Unity Catalog OSS container)', severity: 'optional',
    required: ['LOOM_ICEBERG_CATALOG_URL'], warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail:
      'Delta↔Iceberg dual metadata still works unset: the lakehouse Interop tab writes real Iceberg V2 metadata into your own ADLS Gen2 beside the Delta log, and any engine can be pointed straight at that metadata folder. Setting LOOM_ICEBERG_CATALOG_URL adds CATALOG-based discovery (namespaces, table listing, credential vending) so Trino/Spark/DuckDB/Snowflake can browse instead of being handed paths.',
    remediation:
      'Set LOOM_ICEBERG_CATALOG_URL to the internal-ingress FQDN of the iceberg-catalog Container App (Unity Catalog OSS serving the standard Apache Iceberg REST Catalog surface). Deploy platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep, then set the var on the Console app. Optional overrides: LOOM_ICEBERG_CATALOG_WAREHOUSE (default "loom"), LOOM_ICEBERG_CATALOG_PREFIX (default /api/2.1/unity-catalog/iceberg), LOOM_ICEBERG_CATALOG_AUDIENCE (default api://<LOOM_MSAL_CLIENT_ID>). The catalog is NEVER public — external engines reach it through the audited Loom proxy at /api/catalog/iceberg with a scoped Loom API token.',
    docs: 'https://iceberg.apache.org/docs/latest/rest-catalog-spec/',
    provisionedBy: 'modules/data-plane/iceberg-catalog-aca.bicep (out-of-band standalone entrypoint; admin-plane/main.bicep is at the 256-param ceiling) → LOOM_ICEBERG_CATALOG_URL on the Console app',
    role: 'Storage Blob Data Reader (uami-loom-iceberg-catalog) on the DLZ lake — declared in the module; the Console UAMI needs no new role (the BFF proxies).',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Self-hosted OSS container on the deployment\'s own Container Apps environment reading the deployment\'s own ADLS Gen2 — no SaaS catalog (no Tabular, no Snowflake Open Catalog, no Databricks-hosted Unity Catalog) is in the path, so the full capability runs disconnected in an IL5 / air-gapped enclave.',
    },
  },
  // ── N7e — Trino / Starburst Federated SQL (THE single opt-in carve-out) ──
  //    OPT-IN by design (heavy AKS infra): unset → SQL Lab's "Federated SQL
  //    (Trino)" engine option honest-gates with a Fix-it that discloses the AKS
  //    cost, while the DEFAULT engine (DuckDB N2b) keeps SQL Lab fully
  //    functional — so this opt-in posture gates NO feature and does not breach
  //    loom_default_on_opt_out (round-3 operator decision). NOT optionalDefault:
  //    the /api/sql/trino route is honestly gated when the cluster is absent, so
  //    it must not count as configured.
  {
    id: 'svc-loom-trino', category: 'data-plane', title: 'Federated SQL engine — Trino on AKS (opt-in)', severity: 'optional',
    required: ['LOOM_TRINO_URL'], warnOnMiss: true,
    remediation:
      'Set LOOM_TRINO_URL to the INTERNAL-ingress coordinator URL of the opt-in loom-trino AKS cluster (Trino OSS, Apache-2.0, registered against the N1 Iceberg REST Catalog + external connectors). Deploy platform/fiab/bicep/modules/data-plane/loom-trino-aks.bicep, then set the var on the Console app. This is the ONE opt-in engine in the program: it stands up a full private AKS cluster (real, disclosed cost ~AKS node pool/mo) so it is NOT default-ON — SQL Lab keeps working on DuckDB / Synapse Serverless meanwhile, and Trino only ADDS the "Federated SQL (Trino)" engine choice that can join a Loom Iceberg table with an external Postgres table in one statement. Optional knobs: LOOM_TRINO_ICEBERG_CATALOG (Trino catalog name fronting the Loom lake, default "iceberg"), LOOM_TRINO_AUDIENCE (Entra audience), LOOM_TRINO_TOKEN (Key-Vault secretRef bearer). The cluster is NEVER public — every query goes through the audited BFF at /api/sql/trino.',
    docs: 'https://trino.io/docs/current/connector/iceberg.html',
    provisionedBy: 'modules/data-plane/loom-trino-aks.bicep (out-of-band standalone entrypoint; admin-plane/main.bicep is at the 256-param ceiling) → LOOM_TRINO_URL on the Console app',
    role: 'Storage Blob Data Reader (uami-loom-trino) on the DLZ lake — declared in the module; the Trino workload identity reads Iceberg/Delta data files in place. The Console UAMI needs no new role (the BFF proxies).',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Trino is self-hosted OSS (Apache-2.0) on the deployment\'s own AKS cluster inside the VNet, reading the deployment\'s own ADLS Gen2 via the N1 Iceberg catalog and in-boundary external sources — no SaaS query federation (no Starburst Galaxy, no Athena) is in the path, so the whole capability runs disconnected in an IL5 / air-gapped enclave. SaaS-only external connectors stay honestly gated in IL5. As the opt-in carve-out, its absence removes NO capability — the default DuckDB engine (svc-loom-duckdb) serves SQL Lab in every cloud.',
    },
  },
  {
    id: 'svc-cosmos-control', category: 'data-plane', title: 'Cosmos DB control plane (versions / scaling / CMK)', severity: 'optional',
    required: ['LOOM_COSMOS_ACCOUNT'], anyOf: [['LOOM_DLZ_RG', 'LOOM_ADMIN_RG']], warnOnMiss: true,
    remediation: 'Set LOOM_COSMOS_ACCOUNT (+ the RG vars) so ARM control-plane operations (account scaling, CMK, item version restore) can target the Cosmos account (cosmosConfigGate). Distinct from the data-plane LOOM_COSMOS_ENDPOINT gate — both are needed for full coverage.',
    provisionedBy: 'modules/landing-zone/main.bicep (cosmos account) → apps[] env LOOM_COSMOS_ACCOUNT',
    role: 'Cosmos DB Operator / Contributor (Console UAMI) on the account',
  },
  {
    id: 'svc-medallion-layers', category: 'data-plane', title: 'Medallion layer URLs (Silver / Gold)', severity: 'optional',
    anyOf: [['LOOM_SILVER_URL', 'LOOM_GOLD_URL', 'LOOM_ADLS_ACCOUNT']], warnOnMiss: true,
    remediation: 'Set LOOM_SILVER_URL + LOOM_GOLD_URL (ADLS container URLs; derived from LOOM_ADLS_ACCOUNT when unset) so medallion-aware surfaces (direct-lake, dataflow runs, onelake paths) resolve every layer (gold_url_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep (silver/gold containers) → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI) on the containers',
  },
  {
    id: 'svc-redis-result-cache', category: 'data-plane', title: 'Result-cache Redis (ADX / query result cache)', severity: 'optional',
    required: ['LOOM_RESULT_CACHE_REDIS'], warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'query result caching runs on the built-in in-memory per-replica cache with zero loss of function. Set LOOM_RESULT_CACHE_REDIS (the shared Azure Cache for Redis host) only to make the cache shared across Console replicas.',
    remediation: 'Set LOOM_RESULT_CACHE_REDIS to <redis-host>:6380 (the shared H-band Azure Cache for Redis) to upgrade the per-replica in-memory result cache to a shared cross-replica cache. Optional scale-out — the in-memory default is fully functional.',
    provisionedBy: 'modules/compute/hband-shared.bicep (shared Redis) → LOOM_RESULT_CACHE_REDIS on the Console app',
    role: 'Redis access key from Key Vault (LOOM_RESULT_CACHE_REDIS_PASSWORD secretRef) or AAD data-plane per module wiring',
  },
  // ── DR0 + CMK1 — restore/at-rest posture (loom-next-level ws-verification-dr) ──
  {
    id: 'svc-dr-restore-posture', category: 'data-plane', title: 'DR restore posture — Cosmos PITR + CMK-at-rest + lake recovery', severity: 'optional',
    anyOf: [['LOOM_COSMOS_ACCOUNT', 'LOOM_ADLS_ACCOUNT']], warnOnMiss: true,
    remediation: 'Set LOOM_COSMOS_ACCOUNT (+ LOOM_COSMOS_ACCOUNT_RG) and/or LOOM_ADLS_ACCOUNT (+ LOOM_DLZ_RG) so the restore-posture probe can read live ARM and verify the estate is restorable: the Loom-store Cosmos account on Continuous (PITR) backup, and the lake with blob + container soft delete and change feed on. A push-button deploy ships both by default (drConfig.cosmosBackupTier, default Continuous30Days; recycleRetentionDays soft delete). CMK1: the same probe reports encryption-at-rest — when the deploy mandates customer-managed keys (LOOM_COSMOS_REQUIRE_CMK=true, wired from drConfig.cosmosRequireCmk; IL5 mandate, opt-in elsewhere) a Cosmos account without properties.keyVaultKeyUri is flagged as a posture gap; otherwise the service-managed default is reported honestly. NOTE: blob versioning / blob PITR are "Not yet supported" on HNS (ADLS Gen2) accounts per the Learn feature matrix — the supported lake restore path is soft delete + change feed + Delta time travel, and that is what this row verifies.',
    docs: 'https://learn.microsoft.com/azure/cosmos-db/continuous-backup-restore-introduction',
    provisionedBy: 'modules/admin-plane/loom-console-cosmos.bicep (backupPolicy Continuous, drConfig.cosmosBackupTier; CMK via drConfig.cosmosRequireCmk/cosmosCmkKeyUri/cosmosCmkIdentityId → keyVaultKeyUri + LOOM_COSMOS_REQUIRE_CMK) + modules/landing-zone/cosmos.bicep + cosmos-graph-vector.bicep (same CMK trio) + modules/landing-zone/storage.bicep (soft delete + change feed; versioning/PITR HNS-guarded)',
    role: 'DocumentDB Account Contributor (Console UAMI, already granted) on the Cosmos account + Reader on the DLZ storage account (ARM reads)',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Cosmos continuous backup (PITR), Cosmos customer-managed keys (keyVaultKeyUri + UAMI defaultIdentity), and blob/container soft delete + change feed are GA in Azure Government through IL5 — the whole posture stays in-boundary (key vault + key + UAMI are all in-enclave resources). Blob versioning is a platform-wide HNS limitation (all clouds), not a sovereign gap.',
    },
  },
  {
    id: 'perf-spark-warm-pool-store', category: 'data-plane', title: 'Warm Spark pool — cross-replica lease store (PSR-3)', severity: 'optional',
    anyOf: [['LOOM_SPARK_POOL_LEASE_CONTAINER', 'LOOM_SPARK_POOL_REDIS']], warnOnMiss: true,
    remediation: 'The warm Spark session pool is DEFAULT-ON (instant notebook attach on a warm hit; opt out with LOOM_SPARK_POOL_ENABLED=0 or the /admin/performance kill switch). To make warm sessions SHARED across Console replicas, signal the shared H-band substrate: set LOOM_SPARK_POOL_REDIS to the shared Azure Cache for Redis host from compute/hband-shared.bicep (same value as LOOM_BROKER_REDIS), or set LOOM_SPARK_POOL_LEASE_CONTAINER to a Cosmos container name. Either turns on the cross-replica lease registry (the Cosmos spark-warm-leases container). Unset → the pool runs per-replica (still fully functional, just not shared).',
    provisionedBy: 'modules/landing-zone/cosmos.bicep (loomContainers → spark-warm-leases) + modules/compute/hband-shared.bicep (shared Redis substrate) → LOOM_SPARK_POOL_REDIS / LOOM_SPARK_POOL_LEASE_CONTAINER on the Console app',
    role: 'Cosmos DB Built-in Data Contributor (Console UAMI, already granted) on the loom database — the lease registry is a Cosmos container, no extra grant',
  },
  // ── A11 — FAULTED Spark-pool detection + auto-recovery (Spark reliability) ──
  //    Default-ON/opt-out: unset → the keep-warm heartbeat auto-detects a
  //    FAULTED / "Succeeded-but-can't-launch" pool and delete+recreates it (with
  //    a thrash guard + operator alert). Set LOOM_SPARK_AUTORECOVER_ENABLED=0 to
  //    detect-and-alert only (recreate becomes the manual /admin/health button).
  {
    id: 'svc-spark-autorecover', category: 'data-plane', title: 'Spark pool auto-recovery (FAULTED detect + recreate)', severity: 'optional',
    required: ['LOOM_SPARK_AUTORECOVER_ENABLED'], anyOf: [['LOOM_SPARK_RECOVER_MAX_ATTEMPTS']],
    warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'auto-recovery runs day-one with fully-functional defaults — the keep-warm heartbeat (csa-loom-spark-keepwarm.yml, every 5 min) detects a pool whose ARM provisioningState is Failed/Canceled OR that reports Succeeded while the warm-pool circuit breaker is armed (the "Succeeded but can\'t launch" class), delete+recreates it via the Synapse ARM control plane with exponential backoff, and alerts via the shared action group (dispatchAlert) + an in-product notification. A thrash guard caps recreate attempts per pool (LOOM_SPARK_RECOVER_MAX_ATTEMPTS, default 3, in a 6h window) so a persistently-broken pool backs off instead of looping. Set LOOM_SPARK_AUTORECOVER_ENABLED=0 (or flip the a11-spark-autorecover runtime flag) to keep detection + alerting but require the manual "Recreate pool" action.',
    remediation: 'Auto-recovery of a FAULTED Synapse Spark pool is DEFAULT-ON (opt out with LOOM_SPARK_AUTORECOVER_ENABLED=0 or the a11-spark-autorecover runtime flag on /admin/health → Spark pools). Tune the thrash guard with LOOM_SPARK_RECOVER_MAX_ATTEMPTS (default 3 recreate attempts per pool in a 6h window). No extra resource — it reuses the Console UAMI\'s Synapse Administrator + Contributor grant for bigDataPools delete/create and the O1 shared action group for alerts.',
    docs: 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/runbooks/spark-pools.md',
    provisionedBy: 'modules/landing-zone/synapse.bicep (Console UAMI Synapse Administrator + Contributor on the RG → bigDataPools delete/create) + .github/workflows/csa-loom-spark-keepwarm.yml (durable 5-min heartbeat that drives detection) + monitoring-default-alerts.bicep (LOOM_ALERT_ACTION_GROUP_ID)',
    role: 'Synapse Administrator (workspace) + Contributor (resource group) on the Console UAMI — already granted for the warm pool; recreate is a bigDataPools ARM delete + PUT',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Synapse Spark Big Data pools + the ARM bigDataPools control plane are GA in Azure Government through IL5, so detect + delete/recreate stays fully in-boundary. IL5 note: the same UAMI ARM path applies; only the sovereign ARM host differs (handled by cloud-endpoints).',
    },
  },
  // ── A12 — Spark session quota / vCore budget ceiling (lease hygiene) ────────
  //    Default-ON/opt-out: safe generous defaults; the warm pool refuses to warm
  //    NEW sessions past the ceiling and hard-kills leases idle past the TTL, so
  //    a runaway workload can't exhaust the workspace vCore quota. Unset = the
  //    built-in defaults (session cap + vCore budget) apply.
  {
    id: 'svc-spark-vcore-budget', category: 'data-plane', title: 'Spark session quota — vCore budget ceiling', severity: 'optional',
    anyOf: [['LOOM_SPARK_VCORE_BUDGET', 'LOOM_SPARK_TENANT_SESSION_MAX']],
    warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'session-quota hygiene runs day-one with safe built-in defaults — the warm pool accounts active Spark sessions + estimated vCores (local slots + the cross-replica lease store), refuses to warm a NEW session past LOOM_SPARK_VCORE_BUDGET / LOOM_SPARK_TENANT_SESSION_MAX (returning an honest "session quota reached" structured error rather than hanging), and hard-kills sessions idle past LOOM_SPARK_POOL_IDLE_TTL so leaked leases release their vCores. Set the two vars to tune the ceiling to your Synapse workspace vCore quota; unset applies the built-in defaults.',
    remediation: 'The Spark session-quota / vCore-budget guard is DEFAULT-ON with safe built-in defaults. Tune it with LOOM_SPARK_VCORE_BUDGET (max estimated active Spark vCores across the deployment before the pool refuses to warm a new session; 0 = unlimited) and LOOM_SPARK_TENANT_SESSION_MAX (max concurrent active sessions; 0 = unlimited) to match your Synapse workspace vCore quota. No extra resource — accounting reuses the warm-pool status + the PSR-3 cross-replica lease store.',
    docs: 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/runbooks/spark-pools.md',
    provisionedBy: 'in-Console warm-pool accounting (lib/azure/spark-vcore-budget.ts) over getPoolStatus() + the PSR-3 Cosmos spark-warm-leases tally — no new Azure resource',
    role: 'none beyond the warm pool — the guard is Console-side accounting; killing an over-budget/idle session reuses the Synapse Compute Operator grant the pool already holds',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Pure Console-side accounting over the Synapse Livy session census — available in every cloud the warm pool runs in (Commercial through IL5). No sovereign gap.',
    },
  },
  // ── A13 — Spark chaos-drill harness (default OFF in prod) ───────────────────
  {
    id: 'svc-spark-chaos-drill', category: 'data-plane', title: 'Spark chaos-drill harness (fault injection)', severity: 'optional',
    required: ['LOOM_SPARK_CHAOS_ENABLED'],
    warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'the chaos-drill harness is OFF by default (the fully-functional production posture — no fault injection). It is a tenant-admin, double-gated (LOOM_SPARK_CHAOS_ENABLED=true AND a valid LOOM_INTERNAL_TOKEN) test tool that injects real faults (kill N Livy sessions, arm a pool\'s FAULTED breaker) so the A11 recovery + A12 reaper + warm-pool refill path can be exercised end-to-end in a non-prod environment. Unset/false = disabled, which is the intended default.',
    remediation: 'The Spark chaos-drill harness (POST /api/admin/spark/chaos) is OFF by default and MUST stay off in production. To run a resilience drill in a non-prod deployment, set LOOM_SPARK_CHAOS_ENABLED=true AND present a valid LOOM_INTERNAL_TOKEN on the request (in addition to a tenant-admin session). It injects real faults — kill sessions / arm a pool\'s faulted breaker — to verify the A11 auto-recovery and A12 reaper paths.',
    docs: 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/runbooks/spark-pools.md',
    provisionedBy: 'in-Console route (app/api/admin/spark/chaos) gated by LOOM_SPARK_CHAOS_ENABLED + LOOM_INTERNAL_TOKEN (already wired by admin-plane/main.bicep) — no new Azure resource',
    role: 'Tenant admin (session) + the internal trust token — the drill kills real Livy sessions via the Synapse Compute Operator grant the pool already holds',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'The harness only drives the in-boundary Synapse Livy + warm-pool paths, so it is available in every cloud (Commercial through IL5). It is OFF by default everywhere; a sovereign deployment enables it only for a scheduled non-prod drill.',
    },
  },
  // ── N8 lab 1 — DuckLake catalog option (Postgres-backed lakehouse metadata) ──
  //    Preview / opt-in: a forward bet on the DuckDB ecosystem ALONGSIDE N1's
  //    Iceberg REST Catalog. Unset → the DuckLake editor honest-gates (Fix-it);
  //    N1's IRC and every other surface are unaffected. Not a Fabric dependency.
  {
    id: 'svc-ducklake-catalog', category: 'data-plane', title: 'DuckLake catalog (Postgres-backed lakehouse metadata) — Preview', severity: 'optional',
    required: ['LOOM_DUCKLAKE_CATALOG_URL'], warnOnMiss: true,
    remediation:
      'Set LOOM_DUCKLAKE_CATALOG_URL to the connection string of the Postgres database that backs the DuckLake catalog metadata (postgresql://…/ducklake). DuckLake stores lakehouse table metadata in a SQL database instead of a metadata-file tree; the N2 DuckDB serving tier ATTACHes it (ducklake extension) and reads the Delta/Parquet data in place on your own ADLS Gen2. This is a Preview lab ALONGSIDE the N1 Iceberg REST Catalog (LOOM_ICEBERG_CATALOG_URL), not a replacement — pick the catalog that matches your engine mix. Point it at an existing Azure Database for PostgreSQL flexible server (in-VNet, private endpoint). Unset → the DuckLake catalog editor renders a guided empty state and honest-gates; nothing else changes. No Microsoft Fabric.',
    docs: 'https://ducklake.select/docs/stable/',
    provisionedBy: 'operator-provided Azure Database for PostgreSQL flexible server (in-VNet); no new Loom app — the N2 DuckDB tier is the query engine. LOOM_DUCKLAKE_CATALOG_URL set on the Console app.',
    role: 'The N2 DuckDB tier UAMI reads the lake (Storage Blob Data Reader, already granted); the Postgres connection authenticates per the connection string (AAD token or a Key-Vault-stored credential).',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'DuckLake is an Apache-2.0 catalog format; the metadata store is an in-boundary Azure Database for PostgreSQL and the query engine is the in-boundary DuckDB tier — no SaaS catalog is in the path, so the lab runs disconnected in an IL5 / air-gapped enclave. Preview.',
    },
  },
  // ── N8 lab 3 — S3-compatible ADLS gateway (Preview) ──
  //    Opt-in: expose an S3-compatible endpoint over ADLS for s3://-native OSS
  //    clients. The MinIO gateway path is DROPPED (AGPL + deprecated); the
  //    permissive path is an operator-deployed Apache-2.0 s3proxy in front of
  //    ADLS. Unset → the surface documents that N1's IRC + ADLS SDK path already
  //    covers most external-engine access without a gateway.
  {
    id: 'svc-s3-gateway', category: 'data-plane', title: 'S3-compatible ADLS gateway (Apache-2.0 s3proxy) — Preview', severity: 'optional',
    required: ['LOOM_S3_GATEWAY_URL'], warnOnMiss: true,
    remediation:
      'Set LOOM_S3_GATEWAY_URL to the internal-ingress endpoint of an S3-compatible gateway placed in front of your ADLS Gen2 (an operator-deployed Apache-2.0 s3proxy — the AGPL-licensed MinIO gateway path is NOT used). This lets s3://-native OSS clients (Trino, Spark, DuckDB with the s3 extension) address the lake with an S3 API. In most cases you do NOT need a gateway: the N1 Iceberg REST Catalog (LOOM_ICEBERG_CATALOG_URL) plus the native ADLS/abfss path already give external engines governed, audited access to the same data — deploy the gateway only for clients that speak S3 exclusively. Unset → the S3 gateway editor renders a guided empty state documenting the IRC/ADLS path and honest-gates the connection panel; nothing else changes. No Microsoft Fabric.',
    docs: 'https://github.com/gaul/s3proxy',
    provisionedBy: 'operator-deployed Apache-2.0 s3proxy Container App in front of ADLS Gen2 (out-of-band; the N1 IRC + ADLS SDK path is the default and needs no gateway). LOOM_S3_GATEWAY_URL set on the Console app.',
    role: 'The s3proxy instance carries its own UAMI (Storage Blob Data Reader/Contributor on the lake as needed); the Console only reads the endpoint URL to render connect info.',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 's3proxy is Apache-2.0 and runs in-boundary on the deployment\'s own Container Apps environment; no AGPL MinIO and no SaaS object gateway is in the path, so an IL5 / air-gapped enclave can still expose an S3 face over its own ADLS. Preview.',
    },
  },
  // ── M1 — estate assessment reader (the inbound-migration on-ramp) ──
  //    Opt-in by nature: assessment only runs when you point Loom at a source
  //    estate to migrate FROM. Unset → /admin/migrate fully renders (guided
  //    empty state) and the assess route honest-gates with a Fix-it; a Fabric /
  //    Power BI estate is only ever a migration SOURCE (Loom needs no Fabric).
  {
    id: 'svc-loom-migrate', category: 'data-plane', title: 'Estate assessment reader (inbound migration on-ramp)', severity: 'optional',
    required: ['LOOM_MIGRATE_URL'], warnOnMiss: true,
    remediation:
      'Set LOOM_MIGRATE_URL to the internal-ingress FQDN of the loom-migrate Container App (connects to a Snowflake / Databricks Unity Catalog / Microsoft Fabric / Power BI source estate and enumerates its inventory for the /admin/migrate readiness report). Deploy platform/fiab/bicep/modules/data-plane/loom-migrate-aca.bicep, then set the var on the Console app. The reader is NEVER public — every enumeration goes through the audited BFF at /api/migrate/assess. Each SaaS source still needs its own connection (account/workspace URL + a Key-Vault-stored token) supplied in the surface; until then that connector is honestly gated (never a fabricated count).',
    docs: 'https://learn.microsoft.com/azure/container-apps/',
    provisionedBy: 'modules/data-plane/loom-migrate-aca.bicep (out-of-band standalone entrypoint; admin-plane/main.bicep is at the 256-param ceiling) → LOOM_MIGRATE_URL on the Console app',
    role: 'No new Azure role on the Console UAMI — the BFF proxies to the reader (internal ingress). The reader carries its own UAMI; SaaS-source credentials are Key Vault secrets supplied per connection.',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'The reader runs IN-BOUNDARY on the deployment\'s own Container Apps environment — no SaaS assessment service is in the path, so the on-ramp itself runs disconnected in an IL5 / air-gapped enclave. Individual SaaS-source connectors (Snowflake / Databricks / Fabric / Power BI) reach their own estates and stay honestly gated until their connection prerequisite is provided.',
    },
  },
  // ── N7a — RisingWave stateful streaming-SQL tier (Openness Tier-2 T2-A) ──
  //    Opt-in stateful-streaming BACKEND (~$150-300/mo/cloud); the streaming-sql
  //    ITEM TYPE + editor are default-ON and render fully with LOOM_RISINGWAVE_URL
  //    unset (guided empty state + Fix-it). Azure Stream Analytics stays the LIGHT
  //    default for simple jobs (the stream-analytics-job item) — this is the
  //    stateful class (windowed joins, incremental aggregations) ASA can't express.
  {
    id: 'svc-loom-risingwave', category: 'data-plane', title: 'Streaming SQL tier (RisingWave Container App)', severity: 'optional',
    required: ['LOOM_RISINGWAVE_URL'], warnOnMiss: true,
    remediation:
      'Set LOOM_RISINGWAVE_URL to the internal-ingress FQDN (optionally host:port) of the loom-risingwave '
      + 'Container App (single-node RisingWave, Apache-2.0 — authors streaming materialized views in SQL over '
      + 'Azure Event Hubs via its Kafka endpoint, sinking to Delta/Iceberg on the DLZ lake or the Postgres wire). '
      + 'Deploy platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep, then set the var on the Console '
      + 'app. The tier is NEVER public — every statement goes through the audited BFF at /api/streaming-sql/*. It '
      + 'is an opt-in STATEFUL-streaming tier (~$150-300/mo/cloud); the streaming-sql editor renders fully with '
      + 'the var unset (Azure Stream Analytics still covers simple jobs). Optional: LOOM_RISINGWAVE_DATABASE '
      + '(default dev), LOOM_RISINGWAVE_USER (default root), LOOM_RISINGWAVE_PASSWORD (KV secret; single-node '
      + 'default is in-VNet trust).',
    docs: 'https://docs.risingwave.com/docs/current/intro/',
    provisionedBy: 'modules/data-plane/loom-risingwave-aca.bicep (out-of-band standalone entrypoint; admin-plane/main.bicep is at the 256-param ceiling) → LOOM_RISINGWAVE_URL on the Console app',
    role: 'Storage Blob Data Contributor (uami-loom-risingwave) on the DLZ lake — declared in the module (the streaming sink WRITES Delta/Iceberg). The Console UAMI needs no new role (the BFF proxies over the Postgres wire).',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'RisingWave is a self-contained Rust binary with no external control plane; the Event Hubs Kafka endpoint and ADLS Gen2 are both in-boundary and reachable in Azure Government through IL5, so the whole streaming tier runs disconnected in an air-gapped enclave. No SaaS streaming service, no Microsoft Fabric / OneLake is in the path.',
    },
  },
];
