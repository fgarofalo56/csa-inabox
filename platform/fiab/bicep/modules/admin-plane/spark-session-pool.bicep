// CSA Loom — Warm Spark session pool (config-only)
//
// Kills the ~2-4 min Synapse Spark notebook cold start by keeping N idle Livy
// (Synapse) sessions — or a warmed Databricks all-purpose cluster — on standby.
// On a notebook run the console leases a warm session instead of cold-starting;
// the pool refills itself in the background. This is the Azure-native answer to
// Fabric's instant "starter pools" (no Fabric dependency — Synapse is the
// default backend; Databricks is opt-in via LOOM_NOTEBOOK_BACKEND=databricks).
//
// There is NO new Azure resource to deploy: the pool lives IN the console
// process (lib/azure/spark-session-pool.ts) and warms REAL sessions against the
// already-provisioned Synapse Spark pool / Databricks workspace. This module is
// therefore CONFIG-ONLY — it validates the knobs and emits them as outputs the
// integration pass wires into the console container's env.
//
// ── Integration pass (main.bicep) — add these to the console app's apps[] env ──
// The orchestrator must forward the outputs below onto the `loom-console`
// container's env list (the same place LOOM_AZURE_MAPS_CLIENT_ID etc. are
// wired). DO NOT edit main.bicep from this module — it only produces values:
//
//   LOOM_SPARK_POOL_ENABLED   = string(sparkPoolEnabled)     // "true"/"false"
//   LOOM_SPARK_POOL_MIN       = string(sparkPoolMinWarm)     // min warm sessions/group
//   LOOM_SPARK_POOL_MAX       = string(sparkPoolMaxSessions) // max sessions/group
//   LOOM_SPARK_POOL_IDLE_TTL  = string(sparkPoolIdleTtlSecs) // idle TTL (seconds)
//
// Optional (only when the Databricks backend is opted into):
//   LOOM_DATABRICKS_DEFAULT_CLUSTER = <all-purpose cluster id to keep warm>
//
// Runtime behaviour is unchanged when LOOM_SPARK_POOL_ENABLED is false (the
// default) — notebooks cold-start exactly as they do today. Tenant admins can
// also flip enabled/min/max/TTL live via the /api/spark/session-pool config
// action (per-replica, in-memory) without a redeploy.
//
// Per no-vaporware.md: config-only module, honest gate. Per no-fabric-
// dependency.md: warms the Azure-native Synapse Spark pool by default; no
// api.fabric.microsoft.com on this path.

targetScope = 'resourceGroup'

@description('Primary region — kept for parity with sibling admin-plane modules (config-only module deploys no regional resource).')
#disable-next-line no-unused-params
param location string = resourceGroup().location

@description('Enable the warm Spark session pool. DEFAULT false so notebooks keep today\'s cold-start behaviour until an operator opts in. Wired to LOOM_SPARK_POOL_ENABLED.')
param sparkPoolEnabled bool = false

@description('Minimum warm (idle, pre-provisioned) Spark sessions to keep on standby per pool/kind/sizing group. Each warm session consumes Spark-pool capacity while idle — size against the pool\'s node budget. Wired to LOOM_SPARK_POOL_MIN.')
@minValue(0)
@maxValue(20)
param sparkPoolMinWarm int = 1

@description('Maximum total Spark sessions the pool may hold per group (warm + leased). Guards against runaway warming. Clamped to >= min at runtime. Wired to LOOM_SPARK_POOL_MAX.')
@minValue(1)
@maxValue(50)
param sparkPoolMaxSessions int = 3

@description('Idle TTL (seconds) — a warm-above-min session sitting idle longer than this is evicted (its Livy session is killed) so idle capacity is reclaimed. Warm sessions are kept alive via Livy keepalive until then. Wired to LOOM_SPARK_POOL_IDLE_TTL.')
@minValue(60)
@maxValue(14400)
param sparkPoolIdleTtlSecs int = 900

@description('Compliance tags (accepted for parity; no tagged resource is created).')
#disable-next-line no-unused-params
param complianceTags object = {}

// =====================================================================
// Outputs — the env values the integration pass wires into apps[] env.
// =====================================================================

@description('LOOM_SPARK_POOL_ENABLED — "true"/"false".')
output sparkPoolEnabledEnv string = string(sparkPoolEnabled)

@description('LOOM_SPARK_POOL_MIN — min warm sessions per group.')
output sparkPoolMinEnv string = string(sparkPoolMinWarm)

@description('LOOM_SPARK_POOL_MAX — max sessions per group (>= min).')
output sparkPoolMaxEnv string = string(max(sparkPoolMaxSessions, sparkPoolMinWarm))

@description('LOOM_SPARK_POOL_IDLE_TTL — idle TTL in seconds.')
output sparkPoolIdleTtlEnv string = string(sparkPoolIdleTtlSecs)

@description('Convenience: the full env map to spread onto the console app\'s env array in the integration pass.')
output sparkPoolEnv object = {
  LOOM_SPARK_POOL_ENABLED: string(sparkPoolEnabled)
  LOOM_SPARK_POOL_MIN: string(sparkPoolMinWarm)
  LOOM_SPARK_POOL_MAX: string(max(sparkPoolMaxSessions, sparkPoolMinWarm))
  LOOM_SPARK_POOL_IDLE_TTL: string(sparkPoolIdleTtlSecs)
}
