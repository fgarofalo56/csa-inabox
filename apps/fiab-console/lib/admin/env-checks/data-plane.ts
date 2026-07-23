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
  // ── DR0 — restore posture (loom-next-level ws-verification-dr) ──
  {
    id: 'svc-dr-restore-posture', category: 'data-plane', title: 'DR restore posture — Cosmos PITR + lake recovery', severity: 'optional',
    anyOf: [['LOOM_COSMOS_ACCOUNT', 'LOOM_ADLS_ACCOUNT']], warnOnMiss: true,
    remediation: 'Set LOOM_COSMOS_ACCOUNT (+ LOOM_COSMOS_ACCOUNT_RG) and/or LOOM_ADLS_ACCOUNT (+ LOOM_DLZ_RG) so the restore-posture probe can read live ARM and verify the estate is restorable: the Loom-store Cosmos account on Continuous (PITR) backup, and the lake with blob + container soft delete and change feed on. A push-button deploy ships both by default (drConfig.cosmosBackupTier, default Continuous30Days; recycleRetentionDays soft delete). NOTE: blob versioning / blob PITR are "Not yet supported" on HNS (ADLS Gen2) accounts per the Learn feature matrix — the supported lake restore path is soft delete + change feed + Delta time travel, and that is what this row verifies.',
    docs: 'https://learn.microsoft.com/azure/cosmos-db/continuous-backup-restore-introduction',
    provisionedBy: 'modules/admin-plane/loom-console-cosmos.bicep (backupPolicy Continuous, drConfig.cosmosBackupTier) + modules/landing-zone/storage.bicep (soft delete + change feed; versioning/PITR HNS-guarded)',
    role: 'DocumentDB Account Contributor (Console UAMI, already granted) on the Cosmos account + Reader on the DLZ storage account (ARM reads)',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Cosmos continuous backup (PITR) and blob/container soft delete + change feed are GA in Azure Government through IL5 — the whole posture stays in-boundary. Blob versioning is a platform-wide HNS limitation (all clouds), not a sovereign gap.',
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
];
