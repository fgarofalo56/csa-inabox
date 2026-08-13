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
    id: 'svc-loom-onelake', category: 'data-plane', title: 'Loom OneLake — unified namespace service (Hyperscale)', severity: 'recommended',
    required: ['LOOM_ONELAKE_URL'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_ONELAKE_URL to the internal-ingress Loom OneLake ACA app (loom://<workspace>/<item>.<type>/<path> namespace + shortcut + security + catalog resolver on ADLS Gen2 + Cosmos — no Microsoft Fabric / OneLake DNS). Deploy compute/loom-onelake-app.bicep on the shared substrate from compute/hband-shared.bicep. Unset → the lakehouse/shortcut/security editors use the existing per-item library path (adls-client / lakehouse-shortcuts / onelake-security-client) with no loss of function.',
    provisionedBy: 'modules/compute/hband-shared.bicep (shared UAMIs + Redis) + modules/compute/loom-onelake-app.bicep (out-of-band; admin-plane at 256-param ceiling) → LOOM_ONELAKE_URL on the Console app',
    role: 'Storage Blob Data Contributor (uami-loom-onelake) on the DLZ lake + Cosmos data-plane on the registry containers',
  },
  {
    id: 'svc-loom-directlake', category: 'data-plane', title: 'Loom Direct Lake — columnar cache/scan engine (Hyperscale)', severity: 'recommended',
    required: ['LOOM_DIRECTLAKE_URL'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_DIRECTLAKE_URL to the internal-ingress Loom Direct Lake ACA app (Arrow + delta-rs framing/transcoding + DuckDB/DataFusion scan; the OSS outcome-equivalent of Direct Lake — no VertiPaq, no Power BI). Also set LOOM_SEMANTIC_BACKEND=loom-columnar-cache to route DAX-class queries to it. Deploy compute/loom-directlake-app.bicep on compute/hband-shared.bicep. Unset → the semantic-model / report layer uses the AAS fast-path or the Synapse-Serverless cold path unchanged.',
    provisionedBy: 'modules/compute/hband-shared.bicep (uami-loom-directlake + shared Redis) + modules/compute/loom-directlake-app.bicep (out-of-band) → LOOM_DIRECTLAKE_URL on the Console app',
    role: 'Storage Blob Data Reader (uami-loom-directlake) on the DLZ lake; Redis Data Contributor on the shared cache (wired by hband-shared.bicep)',
  },
  // ── N2b — DuckDB serving tier (the interactive fast path BELOW Spark) ──
  {
    id: 'svc-loom-duckdb', category: 'data-plane', title: 'SQL Lab serving tier (embedded DuckDB Container App)', severity: 'recommended',
    required: ['LOOM_DUCKDB_URL'], warnOnMiss: true, optionalDefault: true,
    rejectUnreachableUrls: ['LOOM_DUCKDB_URL'],
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
    id: 'svc-flight-sql', category: 'data-plane', title: 'Arrow Flight SQL wire (ADBC / JDBC serving)', severity: 'recommended',
    required: ['LOOM_FLIGHTSQL_URL'], warnOnMiss: true, optionalDefault: true,
    rejectUnreachableUrls: ['LOOM_FLIGHTSQL_URL'],
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
  //    DEFAULT-ON since the catalog moved into the orchestrator: admin-plane/
  //    main.bicep deploys data-plane/iceberg-catalog-aca.bicep and emits
  //    LOOM_ICEBERG_CATALOG_URL, so a fresh push-button install arrives wired
  //    (.claude/rules/auto-bind-by-default.md §5 — the value is produced by the
  //    deploy, never asked of the operator).
  //
  //    NOT optionalDefault any more, and that is the point. It used to claim
  //    "Delta↔Iceberg dual metadata still works unset", which is true but is NOT
  //    federated lake access: handing an engine a raw metadata path is not
  //    catalog-based discovery or credential vending. Combined with presence-only
  //    `has()`, that made this gate incapable of reporting anything but Ready —
  //    the live Commercial Console scored it green while carrying the placeholder
  //    `https://0.0.0.0:3000/api/catalog/iceberg` and 503-ing every request. A
  //    gate that cannot go red measures nothing.
  {
    id: 'svc-iceberg-catalog', category: 'data-plane', title: 'Iceberg REST Catalog (Unity Catalog OSS container)', severity: 'recommended',
    required: ['LOOM_ICEBERG_CATALOG_URL'], warnOnMiss: true,
    rejectUnreachableUrls: ['LOOM_ICEBERG_CATALOG_URL'],
    remediation:
      'LOOM_ICEBERG_CATALOG_URL is emitted by the deploy — admin-plane/main.bicep deploys data-plane/iceberg-catalog-aca.bicep (internal-ingress Unity Catalog OSS serving the standard Apache Iceberg REST Catalog surface) by DEFAULT and binds the var on the Console app. Unset or holding an unreachable placeholder therefore means the orchestrator has not been re-run since this shipped, the loom-unity image is not in this ACR, or an operator set loomBackends.icebergCatalog=\'disabled\'. Re-run the admin-plane deployment. Optional overrides: LOOM_ICEBERG_CATALOG_WAREHOUSE (default "loom"), LOOM_ICEBERG_CATALOG_PREFIX (default /api/2.1/unity-catalog/iceberg), LOOM_ICEBERG_CATALOG_AUDIENCE (default api://<LOOM_MSAL_CLIENT_ID>). Until it is wired the lakehouse Interop tab still writes real Iceberg V2 metadata into your own ADLS Gen2 beside the Delta log and an engine can be pointed straight at that folder — but catalog DISCOVERY and credential vending, i.e. the actual federation surface, are absent. The catalog is NEVER public — external engines reach it through the audited Loom proxy at /api/catalog/iceberg with a scoped Loom API token.',
    docs: 'https://iceberg.apache.org/docs/latest/rest-catalog-spec/',
    provisionedBy: 'modules/admin-plane/main.bicep → modules/data-plane/iceberg-catalog-aca.bicep (default-ON, loomBackends.icebergCatalog) → LOOM_ICEBERG_CATALOG_URL on the Console app',
    role: 'Storage Blob Data Reader (uami-loom-iceberg-catalog) on the DLZ lake — declared in the module; the Console UAMI needs no new role (the BFF proxies).',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Self-hosted OSS container on the deployment\'s own Container Apps environment reading the deployment\'s own ADLS Gen2 — no SaaS catalog (no Tabular, no Snowflake Open Catalog, no Databricks-hosted Unity Catalog) is in the path, so the full capability runs disconnected in an IL5 / air-gapped enclave.',
    },
  },
  // ── N7e — Trino Federated SQL. DEFAULT-ON (the AKS carve-out is retired) ──
  //    admin-plane/main.bicep deploys data-plane/loom-trino-aca.bicep — a
  //    single-node Trino OSS Container App, INTERNAL ingress, minReplicas 0, so
  //    idle cost is nothing — and emits LOOM_TRINO_URL. The old opt-in posture
  //    existed only because the AKS shape forced an always-on node pool.
  //
  //    #2678 §3 — THE GATE MUST OBSERVE THE PROPERTY THAT MATTERS. This spec
  //    used to require LOOM_TRINO_URL alone, so a deploy with
  //    loomBackends.trinoAuthMode='disabled' — an engine any workload on the CAE
  //    network could query as any user with an arbitrary X-Trino-User, bypassing
  //    the BFF session check AND the audit row — reported GREEN. The auth mode is
  //    now a REQUIRED var with 'disabled'/'none' rejected, so the anonymous
  //    posture reads as a configuration defect (the same rejectValues mechanism
  //    #2643 introduced for LOOM_UNITY_AUTH_MODE).
  {
    id: 'svc-loom-trino', category: 'data-plane', title: 'Federated SQL engine (Trino Container App)', severity: 'recommended',
    required: ['LOOM_TRINO_URL'], warnOnMiss: true,
    rejectUnreachableUrls: ['LOOM_TRINO_URL'],
    remediation:
      'LOOM_TRINO_URL and LOOM_TRINO_AUTH_MODE are emitted by the deploy — admin-plane/main.bicep deploys data-plane/loom-trino-aca.bicep by DEFAULT (single-node Trino OSS, Apache-2.0, internal ingress, minReplicas 0 so it bills nothing at idle) and binds both vars. Unset means the orchestrator has not been re-run since this shipped, the loom-trino image is not in this ACR, a non-Container-Apps boundary, or an explicit loomBackends.trino=\'disabled\' opt-out; SQL Lab then keeps executing on the DEFAULT DuckDB tier with the identical result surface. LOOM_TRINO_AUTH_MODE=disabled is a SECURITY defect, not a missing value: it restores the anonymous posture in which anything already on the CAE network can query the lake as any user, bypassing the BFF session check and the audit row — remove the loomBackends.trinoAuthMode override to return to Entra bearer authorization. The value \'sealed\' is expected on a from-scratch install (authorization enforced against a sentinel audience nothing can mint, because ARM cannot create the Entra app registration); run .github/workflows/csa-loom-post-deploy-bootstrap.yml and redeploy to un-seal it. Optional knobs: LOOM_TRINO_ICEBERG_CATALOG (Trino catalog name fronting the Loom lake, default "iceberg"), loomBackends.trinoCatalogs / trinoCatalogSecrets (declarative external sources), loomBackends.trinoCatalogPolicy (per-catalog grant table). The engine is NEVER public — every query goes through the audited BFF at /api/sql/trino.',
    docs: 'https://trino.io/docs/current/connector/iceberg.html',
    provisionedBy: 'modules/admin-plane/main.bicep → modules/data-plane/loom-trino-aca.bicep (default-ON, loomBackends.trino) → LOOM_TRINO_URL + LOOM_TRINO_AUTH_MODE on the Console app. The multi-node private-AKS module (data-plane/loom-trino-aks.bicep) remains the opt-in scale-out path.',
    role: 'Storage Blob Data Reader on the DLZ lake for the identity the engine runs as (granted at the lake\'s resource-group scope by data-plane/loom-trino-lake-rbac.bicep) — it reads Iceberg/Delta data files in place, read-only by construction. The Console UAMI needs no new role (the BFF proxies).',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Trino is self-hosted OSS (Apache-2.0) on the deployment\'s own Container Apps environment inside the VNet, reading the deployment\'s own ADLS Gen2 via the N1 Iceberg catalog and in-boundary external sources — no SaaS query federation (no Starburst Galaxy, no Athena) is in the path, so the whole capability runs disconnected in an IL5 / air-gapped enclave. SaaS-only external connectors stay honestly gated in IL5. If the engine is absent the default DuckDB tier (svc-loom-duckdb) still serves SQL Lab in every cloud.',
    },
  },
  // ── N7e — the Trino ENGINE-LEVEL AUTHORIZATION posture (#2678 §3) ──
  //
  // A SEPARATE spec, exactly like svc-loom-unity-authz next door, and for the
  // same reason. The hole #2678 named is that a deploy with
  // loomBackends.trinoAuthMode='disabled' — an engine anything on the CAE
  // network can query as any user via an arbitrary X-Trino-User, bypassing both
  // the BFF session check and the audit row — reported GREEN, because
  // LOOM_TRINO_AUTH_MODE appeared only in PROSE and never in a required/anyOf
  // array. A gate satisfied by its own failure mode measures nothing.
  //
  // WHY NOT simply add the var to svc-loom-trino's `required`: /api/sql/trino
  // hard-gates on that spec via backendGateResponse, so a var added there would
  // 503 the engine on every estate that has not redeployed yet. An honest health
  // finding must not become an outage. This spec observes the posture; the
  // sibling spec keeps owning "is the engine reachable".
  //
  // 'sealed' is deliberately NOT rejected: it means authorization is ENFORCED
  // against a sentinel audience nothing can mint — the correct from-scratch
  // state until the sign-in bootstrap runs. Enforced-but-unusable, not open.
  {
    id: 'svc-loom-trino-authz', category: 'data-plane',
    title: 'Federated SQL engine — authorization posture (Entra bearer)', severity: 'recommended',
    required: ['LOOM_TRINO_AUTH_MODE'],
    rejectValues: { LOOM_TRINO_AUTH_MODE: ['disabled', 'none', 'off', 'anonymous'] },
    appliesWhenPresent: {
      envVar: 'LOOM_TRINO_URL',
      notDeployedDetail:
        'the Federated SQL (Trino) engine is not stood up in this estate, so there is no query surface to authorize and no anonymous endpoint to expose. SQL Lab runs on the DuckDB tier (svc-loom-duckdb). Deploy the engine and this check applies in full.',
    },
    warnOnMiss: true,
    remediation:
      'LOOM_TRINO_AUTH_MODE is emitted by admin-plane/main.bicep alongside LOOM_TRINO_URL and reports the posture the deploy actually chose: "entra" (enforced, audience pinned - queries run), "sealed" (enforced against a sentinel audience nothing can mint - the expected from-scratch state until the sign-in bootstrap has run) or "disabled". A value of disabled/none/off/anonymous is a SECURITY defect, not a missing setting: it restores the posture in which anything already on the CAE network can query the lake as any user with an arbitrary X-Trino-User header, bypassing the BFF session check and the audit row - internal ingress alone is not an authorization control. Remove the loomBackends.trinoAuthMode override and redeploy. If the var is simply absent while LOOM_TRINO_URL is set, the estate is running a revision that predates the authorization work - re-run the admin-plane deployment.',
    docs: 'https://trino.io/docs/current/security/jwt.html',
    provisionedBy: 'modules/admin-plane/main.bicep -> LOOM_TRINO_AUTH_MODE on the Console app (derived from loomBackends.trinoAuthMode + whether an Entra audience could be pinned)',
    role: 'No Azure role. The engine validates an Entra bearer against the active cloud JWKS with the audience pinned by data-plane/loom-trino-aca.bicep.',
  },
  {
    id: 'svc-cosmos-control', category: 'data-plane', title: 'Cosmos DB control plane (versions / scaling / CMK)', severity: 'recommended',
    required: ['LOOM_COSMOS_ACCOUNT'], anyOf: [['LOOM_DLZ_RG', 'LOOM_ADMIN_RG']], warnOnMiss: true,
    remediation: 'Set LOOM_COSMOS_ACCOUNT (+ the RG vars) so ARM control-plane operations (account scaling, CMK, item version restore) can target the Cosmos account (cosmosConfigGate). Distinct from the data-plane LOOM_COSMOS_ENDPOINT gate — both are needed for full coverage.',
    provisionedBy: 'modules/landing-zone/main.bicep (cosmos account) → apps[] env LOOM_COSMOS_ACCOUNT',
    role: 'Cosmos DB Operator / Contributor (Console UAMI) on the account',
  },
  {
    id: 'svc-medallion-layers', category: 'data-plane', title: 'Medallion layer URLs (Silver / Gold)', severity: 'recommended',
    anyOf: [['LOOM_SILVER_URL', 'LOOM_GOLD_URL', 'LOOM_ADLS_ACCOUNT']], warnOnMiss: true,
    remediation: 'Set LOOM_SILVER_URL + LOOM_GOLD_URL (ADLS container URLs; derived from LOOM_ADLS_ACCOUNT when unset) so medallion-aware surfaces (direct-lake, dataflow runs, onelake paths) resolve every layer (gold_url_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep (silver/gold containers) → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI) on the containers',
  },
  {
    id: 'svc-redis-result-cache', category: 'data-plane', title: 'Result-cache Redis (ADX / query result cache)', severity: 'recommended',
    required: ['LOOM_RESULT_CACHE_REDIS'], warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'query result caching runs on the built-in in-memory per-replica cache with zero loss of function. Set LOOM_RESULT_CACHE_REDIS (the shared Redis host) only to make the cache shared across Console replicas.',
    remediation: 'Set LOOM_RESULT_CACHE_REDIS to the shared H-band Redis endpoint to upgrade the per-replica in-memory result cache to a shared cross-replica cache. Use the redisEndpoint output of compute/hband-shared.bicep verbatim — it is <host>:10000 on Azure Managed Redis (Commercial) and <host>:6380 on the retiring Azure Cache for Redis (Azure Government, where Managed Redis is unavailable), so do not hard-code a port. Optional scale-out — the in-memory default is fully functional.',
    provisionedBy: 'modules/compute/hband-shared.bicep (shared Redis) → LOOM_RESULT_CACHE_REDIS on the Console app',
    role: 'Redis access key from Key Vault (LOOM_RESULT_CACHE_REDIS_PASSWORD secretRef) or AAD data-plane per module wiring',
  },
  // ── DR0 + CMK1 — restore/at-rest posture (loom-next-level ws-verification-dr) ──
  {
    id: 'svc-dr-restore-posture', category: 'data-plane', title: 'DR restore posture — Cosmos PITR + CMK-at-rest + lake recovery', severity: 'recommended',
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
    id: 'perf-spark-warm-pool-store', category: 'data-plane', title: 'Warm Spark pool — cross-replica lease store (PSR-3)', severity: 'recommended',
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
    id: 'svc-spark-autorecover', category: 'data-plane', title: 'Spark pool auto-recovery (FAULTED detect + recreate)', severity: 'recommended',
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
    id: 'svc-spark-vcore-budget', category: 'data-plane', title: 'Spark session quota — vCore budget ceiling', severity: 'recommended',
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
    id: 'svc-spark-chaos-drill', category: 'data-plane', title: 'Spark chaos-drill harness (fault injection)', severity: 'recommended',
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
  // ── CH1 — Dependency-fault chaos harness (default OFF in prod) ───────────────
  {
    id: 'svc-dependency-chaos-drill', category: 'data-plane', title: 'Dependency-fault chaos harness (Cosmos / AOAI / ADX / KV)', severity: 'recommended',
    required: ['LOOM_DEPENDENCY_CHAOS_ENABLED'],
    warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'the dependency-fault chaos harness is OFF by default (the fully-functional production posture — no fault injection). It is a tenant-admin, triple-gated (the ch1-dependency-chaos runtime flag ON + LOOM_DEPENDENCY_CHAOS_ENABLED=true + a valid LOOM_INTERNAL_TOKEN) resilience-DRILL tool that injects real faults (Cosmos-429, Azure OpenAI 429/timeout, ADX cold-start 503, Key Vault throttle) against a replica so the serve-stale / honest-gate / breaker paths can be proven end-to-end in a non-prod environment. Every armed fault auto-expires (≤5 min). Unset/false = disabled, which is the intended default.',
    remediation: 'The dependency-fault chaos harness (POST /api/admin/chaos/dependency) is OFF by default and MUST stay off in production. To run a resilience drill in a non-prod deployment, enable the ch1-dependency-chaos runtime flag, set LOOM_DEPENDENCY_CHAOS_ENABLED=true AND present a valid LOOM_INTERNAL_TOKEN on the request (in addition to a tenant-admin session). It injects real dependency faults to verify the getOrComputeCached serve-stale, aoai-chat-client fallback, and honest-error paths degrade gracefully — never a crash or dark render.',
    docs: 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/resilience-matrix.md',
    provisionedBy: 'in-Console route (app/api/admin/chaos/dependency) gated by the ch1-dependency-chaos flag + LOOM_DEPENDENCY_CHAOS_ENABLED + LOOM_INTERNAL_TOKEN (already wired by admin-plane/main.bicep) — no new Azure resource',
    role: 'Tenant admin (session) + the internal trust token — the drill arms an in-process fault registry the live cosmos-client / fetch-with-timeout chokepoints consult; no Azure permission is exercised by arming',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'The harness only drives in-process fault injection at the Console\'s own transport chokepoints, so it is available in every cloud (Commercial through IL5). It is OFF by default everywhere; a sovereign deployment enables it only for a scheduled non-prod drill.',
    },
  },
  // ── N8 lab 1 — DuckLake catalog option (Postgres-backed lakehouse metadata) ──
  //    DEFAULT-ON since 2026-07 (loom_default_on_opt_out): the Postgres store is
  //    deployed by data-plane/ducklake-catalog-postgres.bicep and the DSN is
  //    bound as a Key Vault secretRef, so a fresh deploy arrives wired. A
  //    forward bet on the DuckDB ecosystem ALONGSIDE N1's Iceberg REST Catalog.
  //    Unset only when the Azure Postgres quota gate trips → the DuckLake editor
  //    honest-gates (Fix-it); N1's IRC and every other surface are unaffected.
  //    Not a Fabric dependency.

  {
    id: 'svc-ducklake-catalog', category: 'data-plane', title: 'DuckLake catalog (Postgres-backed lakehouse metadata) — Preview', severity: 'recommended',
    required: ['LOOM_DUCKLAKE_CATALOG_URL'], warnOnMiss: true,
    remediation:
      'LOOM_DUCKLAKE_CATALOG_URL is the connection string of the Postgres database that backs the DuckLake catalog metadata (postgresql://…/ducklake). DuckLake stores lakehouse table metadata in a SQL database instead of a metadata-file tree; the N2 DuckDB serving tier ATTACHes it (ducklake extension) and reads the Delta/Parquet data in place on your own ADLS Gen2. This is a lab ALONGSIDE the N1 Iceberg REST Catalog (LOOM_ICEBERG_CATALOG_URL), not a replacement — pick the catalog that matches your engine mix. NOTHING TO DO on a normal deployment: platform/fiab/bicep/modules/data-plane/ducklake-catalog-postgres.bicep provisions the store by DEFAULT (private-endpoint-only Standard_B1ms flexible server) and admin-plane/main.bicep binds this var as a Key Vault secretRef, so a from-scratch COMMERCIAL deploy arrives wired. It is unset in four cases: the apps tier is off (deployAppsEnabled=false — the server is deliberately not billed before a Console exists to read it), an AKS boundary (the DuckDB engine that runs the ATTACH is Container-Apps-only), postgresQuotaAvailable=false, or you point it at your own server instead. GCC-HIGH AND IL5 SET postgresQuotaAvailable=false TODAY, so on those boundaries this gate is the expected state. PostgreSQL Flexible Server IS an Azure Government service (US Gov Virginia / Arizona / Texas), so that is not a service gap — the same flag also gates the OSS Airflow host, whose image is an unmirrored docker.io pull and whose metadata Postgres is created with public network access enabled, and both are being fixed before the sovereign flip (see the comment on postgresQuotaAvailable in params/gcc-high.bicepparam). A genuinely quota-restricted subscription requests an increase at https://aka.ms/postgres-request-quota-increase. Unset → the DuckLake catalog editor renders a guided empty state and honest-gates; nothing else changes. No Microsoft Fabric.',
    docs: 'https://ducklake.select/docs/stable/',
    provisionedBy: 'platform/fiab/bicep/modules/data-plane/ducklake-catalog-postgres.bicep — DEFAULT-ON, invoked by admin-plane/main.bicep (ducklakeCatalogActive). Private-endpoint-only Azure Database for PostgreSQL flexible server (Standard_B1ms, ~$16/mo/cloud); the assembled DSN is written to the Loom Key Vault and bound to the Console as the `loom-ducklake-catalog-url` secretRef — never a plain env value. No new Loom app: the N2 DuckDB tier is the query engine.',

    role: 'The N2 DuckDB tier UAMI reads the lake (Storage Blob Data Reader, already granted); the Postgres connection authenticates per the connection string (AAD token or a Key-Vault-stored credential).',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'DuckLake is an Apache-2.0 catalog format; the metadata store is an in-boundary Azure Database for PostgreSQL and the query engine is the in-boundary DuckDB tier — no SaaS catalog is in the path, so the lab runs disconnected in an IL5 / air-gapped enclave. Preview.',
    },
  },
  // ── N8 lab 3 — S3-compatible ADLS gateway. DEFAULT-ON (#2682 / FINISHLINE D16) ──
  //    Expose an S3-compatible endpoint over ADLS for s3://-native OSS clients.
  //    The MinIO gateway path is DROPPED (AGPL + deprecated); the permissive path
  //    is Apache-2.0 s3proxy, deployed BY THE PLATFORM.
  //
  //    WHY THIS SPEC CHANGED. The gateway was designed default-ON, then pulled to
  //    `optIn: true` in PR #2640 round 4 because its image resolved to an
  //    anonymous docker.io pull on every shipped lane. The image problem was real;
  //    the opt-in was never a policy decision, and it left this spec contradicting
  //    ITSELF — core.ts's VALUE_HINT described a bicep-wired internal endpoint
  //    ("bicep-wired; unset only when the apps tier is off") while the spec here
  //    told operators to go deploy a gateway out-of-band. An opt-in whose only
  //    cause is a defect elsewhere is a standing violation of the default-ON rule
  //    (`loom_default_on_opt_out`) and of auto-bind-by-default §5 (infra
  //    prerequisites are DEPLOYED, not requested).
  //
  //    The image cause is closed: the upstream coordinate is digest-pinned in
  //    platform/fiab/images/upstream-images.json, mirrored into each cloud's own
  //    ACR by scripts/ci/mirror-upstream-images.sh, and
  //    data-plane/s3-gateway-aca.bicep REQUIRES an acrLoginServer — it has no
  //    public-pull branch left. So the opt-in is removed here.
  //
  //    NOT `optionalDefault`: an unset value is not a fully-functional posture
  //    with a safe built-in default, it means the gateway did not deploy. It stays
  //    `warnOnMiss` (a warn, not a hard fail) because the N1 Iceberg REST Catalog +
  //    native ADLS/abfss path already give external engines governed access, so a
  //    missing gateway degrades one access shape rather than breaking the lake.
  //    Its severity is `recommended` — the deploy is supposed to wire
  //    LOOM_S3_GATEWAY_URL, so an unset one is a deploy defect to fix (#3347).
  {
    id: 'svc-s3-gateway', category: 'data-plane', title: 'S3-compatible ADLS gateway (Apache-2.0 s3proxy) — Preview', severity: 'recommended',
    required: ['LOOM_S3_GATEWAY_URL'], warnOnMiss: true,
    remediation:
      'LOOM_S3_GATEWAY_URL is emitted by the deploy — the Apache-2.0 s3proxy Container App (data-plane/s3-gateway-aca.bicep) is deployed by DEFAULT in front of the deployment\'s own ADLS Gen2, internal ingress only, read-only by default, minReplicas 0 so it bills nothing at idle. It is stood up by whichever pass owns the lake: modules/admin-plane/main.bicep when a lake is bound at admin-plane time, otherwise the dlz-attach pass (platform/fiab/bicep/main.bicep dlzAttachS3Gateway), which also patches this var onto the already-running Console. Unset therefore means one of: THE DEPLOYING IDENTITY CANNOT GRANT ON A CROSS-SUBSCRIPTION LAKE (see below — this was the live Commercial cause, #3337); the orchestrator has not been re-run since this shipped; the s3proxy image is not in this ACR (run the cloud\'s image lane — full-app-deploy-commercial.yml or gov-provision-dataplane-images.yml — which mirrors it in BY DIGEST from platform/fiab/images/upstream-images.json); a dlz-attach run that carried no hub ACR / Container Apps environment coordinate; or a non-Container-Apps boundary. THE CROSS-SUB CAUSE, precisely: the gateway runs as its own dedicated identity and must hold Storage Blob Data Reader on the lake. When the lake was adopted from a Data Landing Zone SUBSCRIPTION, admin-plane cannot create that assignment (a subscription-scoped deployment cannot grant in another subscription) and the cross-subscription grant pass (modules/data-plane/dlz-lake-grant-pass.bicep, #3336) takes over — but only when the deploy lane MEASURED that the deploying service principal holds Microsoft.Authorization/roleAssignments/write at the lake\'s resource group. If it does not, the gateway is deliberately NOT deployed rather than shipped bound-but-ungranted: a wired URL that 403s every bucket is worse than this honest block (no-vaporware.md). THE FIX IS ONE GRANT: give the deploying service principal "User Access Administrator" (or "Role Based Access Control Administrator", or Owner) on the lake\'s subscription or resource group, then re-run deploy-fiab-commercial.yml — the deploy measures again, arms the pass, and the gateway deploys granted. Nothing else is affected meanwhile: the N1 Iceberg REST Catalog (LOOM_ICEBERG_CATALOG_URL) plus the native ADLS/abfss path already give external engines governed, audited access to the same data, so only s3://-exclusive clients (Trino, Spark, DuckDB with the s3 extension, boto3) need this face. The S3 wire credential pair is mirrored into Key Vault as loom-s3-gateway-access-key / loom-s3-gateway-secret-key. The gateway is NEVER public (external:false). No Microsoft Fabric.',
    docs: 'https://github.com/gaul/s3proxy',
    provisionedBy: 'modules/admin-plane/main.bicep → modules/data-plane/s3-gateway-aca.bicep (default-ON whenever a lake is BOUND and its grant has an owner — same-sub via s3-gateway-lake-rbac.bicep, cross-sub via the measured dlzLakeGrantPass in platform/fiab/bicep/main.bicep), else platform/fiab/bicep/main.bicep dlzAttachS3Gateway on the dlz-attach pass → LOOM_S3_GATEWAY_URL on the Console app. The s3proxy image is pulled from the deployment\'s OWN ACR (digest-pinned mirror; the module has no public-registry branch).',
    role: 'The gateway runs as its OWN least-privilege identity (uami-loom-s3gw-<region>) holding Storage Blob Data READER on the lake — granted by data-plane/s3-gateway-lake-rbac.bicep when the lake is in the deployment\'s subscription, or by data-plane/dlz-lake-grant-pass.bicep at the lake\'s own scope when it is not (#3336) — never as the Console UAMI. The Console UAMI is used only as the ACR pull credential and reads the endpoint URL to render connect info. THE DEPLOYING PRINCIPAL therefore needs Microsoft.Authorization/roleAssignments/write at the lake: User Access Administrator, Role Based Access Control Administrator, or Owner on the lake\'s subscription or resource group. Without it the gateway is not deployed at all — deliberately, so it is never bound-but-ungranted.',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 's3proxy is Apache-2.0 and runs in-boundary on the deployment\'s own Container Apps environment from the deployment\'s own ACR mirror; no AGPL MinIO, no SaaS object gateway and no public-registry pull is in the path, so an IL5 / air-gapped enclave can still expose an S3 face over its own ADLS. Preview.',
    },
  },
  // ── M1 — estate assessment reader (the inbound-migration on-ramp) ──
  //    DEFAULT-ON since 2026-07-28: admin-plane/main.bicep deploys the reader on
  //    every apps-enabled deploy (all boundaries) and wires LOOM_MIGRATE_URL, so
  //    a fresh push-button deploy closes this gate. Scale-to-zero (~$0 idle).
  //    Unset → /admin/migrate fully renders (guided empty state) and the assess
  //    route honest-gates with a Fix-it; a Fabric / Power BI estate is only ever
  //    a migration SOURCE (Loom needs no Fabric).
  {
    id: 'svc-loom-migrate', category: 'data-plane', title: 'Estate assessment reader (inbound migration on-ramp)', severity: 'recommended',
    required: ['LOOM_MIGRATE_URL'], warnOnMiss: true,
    remediation:
      'LOOM_MIGRATE_URL is set by the deployment itself — admin-plane/main.bicep deploys data-plane/loom-migrate-aca.bicep by default and wires the reader\'s internal FQDN. If it is unset, this estate predates that wiring (redeploy), the apps tier has not deployed yet, or an admin opted out with loomBackends.loomMigrate=\'disabled\'. To set it manually, point it at the internal-ingress FQDN of the loom-migrate Container App (connects to a Snowflake / Databricks Unity Catalog / Microsoft Fabric / Power BI source estate and enumerates its inventory for the /admin/migrate readiness report). The reader is NEVER public — every enumeration goes through the audited BFF at /api/migrate/assess, and it scales to zero so it costs nothing when no assessment is running. Each SaaS source still needs its own connection (account/workspace URL + a Key-Vault-stored token) supplied in the surface; until then that connector is honestly gated (never a fabricated count).',
    docs: 'https://learn.microsoft.com/azure/container-apps/',
    provisionedBy: 'modules/data-plane/loom-migrate-aca.bicep — deployed DEFAULT-ON by admin-plane/main.bicep (every Container Apps boundary, Commercial + Gov) → LOOM_MIGRATE_URL wired onto the Console app by the same template. Also directly deployable out of band for an incremental provision (.github/workflows/gov-provision-streaming-migrate.yml does this for the live Gov estate).',
    role: 'No new Azure role on the Console UAMI — the BFF proxies to the reader (internal ingress). The reader carries its own dedicated uami-loom-migrate-<region> holding AcrPull ONLY (zero data-plane roles); SaaS-source credentials are Key Vault secrets supplied per connection.',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'The reader runs IN-BOUNDARY on the deployment\'s own Container Apps environment — no SaaS assessment service is in the path, so the on-ramp itself runs disconnected in an IL5 / air-gapped enclave. Individual SaaS-source connectors (Snowflake / Databricks / Fabric / Power BI) reach their own estates and stay honestly gated until their connection prerequisite is provided.',
    },
  },
  // ── N7a — RisingWave stateful streaming-SQL tier (Openness Tier-2 T2-A) ──
  //    DEFAULT-ON since 2026-07-28: admin-plane/main.bicep deploys the tier on
  //    every apps-enabled deploy (all boundaries) and wires LOOM_RISINGWAVE_URL.
  //    It is the ONE runtime here that cannot scale to zero (single-node MV +
  //    meta state lives in process), so it runs 1 replica at the smallest
  //    ACA-legal size. PLAN AGAINST THE ACTIVE RATE, ~$150/mo/cloud: ACA only
  //    bills idle rates while a replica stays under 0.01 vCPU and 1 KB/s, and a
  //    single-node engine running meta heartbeats, barriers and compaction does
  //    not. Admin opt-OUT is
  //    loomBackends.risingwave='disabled'. Unset → the streaming-sql editor
  //    renders fully (guided empty state + Fix-it) and Azure Stream Analytics
  //    (the stream-analytics-job item) still covers simple jobs.
  {
    id: 'svc-loom-risingwave', category: 'data-plane', title: 'Streaming SQL tier (RisingWave Container App)', severity: 'recommended',
    required: ['LOOM_RISINGWAVE_URL'], warnOnMiss: true,
    remediation:
      'LOOM_RISINGWAVE_URL is set by the deployment itself — admin-plane/main.bicep deploys '
      + 'data-plane/loom-risingwave-aca.bicep by default and wires <fqdn>:4566. If it is unset, this estate '
      + 'predates that wiring (redeploy), the apps tier has not deployed yet, or an admin opted out with '
      + 'loomBackends.risingwave=\'disabled\'. To set it manually, point it at the internal-ingress FQDN '
      + '(optionally host:port) of the loom-risingwave Container App (single-node RisingWave, Apache-2.0 — '
      + 'authors streaming materialized views in SQL over Azure Event Hubs via its Kafka endpoint, sinking to '
      + 'Delta/Iceberg on the DLZ lake or the Postgres wire). The tier is NEVER public — every statement goes '
      + 'through the audited BFF at /api/streaming-sql/*. COST: a streaming engine cannot scale to zero without '
      + 'losing its materialized-view state, so this runs 1 replica at 2.0 vCPU / 4.0Gi. Budget the ACTIVE rate, '
      + 'about $150/mo per cloud: ACA charges idle rates only while a replica stays below 0.01 vCPU and 1 KB/s, '
      + 'and a single-node engine running meta heartbeats, barriers and compaction does not. Note the replica '
      + 'filesystem is EPHEMERAL unless RW_STATE_STORE is pointed at durable object storage — a revision roll or '
      + 'a platform replica replacement drops the materialized views either way. AUTHENTICATION IS MANDATORY and '
      + 'the deployment sets it up: RisingWave ships its `root` superuser with NO password, and every app in a '
      + 'Container Apps environment draws its pod IP from the SAME infrastructure subnet — so an unauthenticated '
      + 'engine is reachable as root by loom-script-runner and loom-udf-runtime, two services that execute '
      + 'user-supplied code (found live on 2026-07-29 and removed from the estate). No ACA ingress IP rule can '
      + 'separate environment siblings, so the fix is a credential: admin-plane/main.bicep generates an '
      + 'unpredictable password, stores it in the Loom Key Vault, and binds it on BOTH the engine and the Console '
      + 'as a Key-Vault-backed Container Apps secretRef (LOOM_RISINGWAVE_PASSWORD) — never a plain env literal. '
      + 'The image refuses to start without it. The credential alone was not enough either: stock RisingWave '
      + 'single-node binds FIVE routable ports and only the Postgres wire (4566) authenticates — meta gRPC 5690 '
      + 'can create and drop catalog objects — and ACA ingress is not a firewall, because a replica is reachable '
      + 'on its pod IP regardless of targetPort. The image now binds meta, dashboard, compute and compactor to '
      + '127.0.0.1 only and asserts it at boot (zero routable sockets while sealed, exactly one while serving, '
      + 'container dies otherwise). Optional overrides: LOOM_RISINGWAVE_DATABASE (default dev), '
      + 'LOOM_RISINGWAVE_USER (default root).',
    docs: 'https://docs.risingwave.com/docs/current/intro/',
    provisionedBy: 'modules/data-plane/loom-risingwave-aca.bicep — deployed DEFAULT-ON by admin-plane/main.bicep (every Container Apps boundary, Commercial + Gov) → LOOM_RISINGWAVE_URL wired onto the Console app by the same template. Also directly deployable out of band for an incremental provision (.github/workflows/gov-provision-streaming-migrate.yml does this for the live Gov estate).',
    role: 'Storage Blob Data Contributor on the DLZ lake for the dedicated uami-loom-risingwave-<region> (the streaming sink WRITES Delta/Iceberg) — granted by admin-plane/main.bicep at the DLZ resource-group scope, plus AcrPull on the Loom ACR and Key Vault Secrets User on the Loom vault (it resolves its own mandatory root credential at revision start). The Console UAMI needs no new Azure role — it already holds Key Vault Secrets Officer, which covers reading the same secret. Nothing else in the Container Apps environment is granted read on that secret; that grant IS the boundary between the streaming database and the code-execution apps it shares an environment with.',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'RisingWave is a self-contained Rust binary with no external control plane; the Event Hubs Kafka endpoint and ADLS Gen2 are both in-boundary and reachable in Azure Government through IL5, so the whole streaming tier runs disconnected in an air-gapped enclave. No SaaS streaming service, no Microsoft Fabric / OneLake is in the path.',
    },
  },
];
