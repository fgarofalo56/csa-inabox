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
  {
    id: 'perf-spark-warm-pool-store', category: 'data-plane', title: 'Warm Spark pool — cross-replica lease store (PSR-3)', severity: 'optional',
    anyOf: [['LOOM_SPARK_POOL_LEASE_CONTAINER', 'LOOM_SPARK_POOL_REDIS']], warnOnMiss: true,
    remediation: 'The warm Spark session pool is DEFAULT-ON (instant notebook attach on a warm hit; opt out with LOOM_SPARK_POOL_ENABLED=0 or the /admin/performance kill switch). To make warm sessions SHARED across Console replicas, signal the shared H-band substrate: set LOOM_SPARK_POOL_REDIS to the shared Azure Cache for Redis host from compute/hband-shared.bicep (same value as LOOM_BROKER_REDIS), or set LOOM_SPARK_POOL_LEASE_CONTAINER to a Cosmos container name. Either turns on the cross-replica lease registry (the Cosmos spark-warm-leases container). Unset → the pool runs per-replica (still fully functional, just not shared).',
    provisionedBy: 'modules/landing-zone/cosmos.bicep (loomContainers → spark-warm-leases) + modules/compute/hband-shared.bicep (shared Redis substrate) → LOOM_SPARK_POOL_REDIS / LOOM_SPARK_POOL_LEASE_CONTAINER on the Console app',
    role: 'Cosmos DB Built-in Data Contributor (Console UAMI, already granted) on the loom database — the lease registry is a Cosmos container, no extra grant',
  },
];
