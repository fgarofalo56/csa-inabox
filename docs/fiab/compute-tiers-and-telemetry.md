# Compute tiers & Spark telemetry (deploy-time provisioning)

CSA Loom provisions **workload-tiered Spark/Databricks compute** and **Spark
application telemetry to Log Analytics at deploy time** — no manual portal
steps. This closes the operator-flagged gap where a live deployment had a single
untuned Spark pool, no pool-level telemetry, and zero Databricks instance
pools/cluster policies.

Everything here is **Azure-native and default-on** (per `.claude/rules`
`no-fabric-dependency.md` + the default-ON/opt-out principle). Synapse Spark is
the default notebook/spark-job backend; Databricks is the opt-in alternative
(`LOOM_NOTEBOOK_BACKEND=databricks`). No Fabric capacity or workspace is
required.

---

## 1. Synapse Spark workload tiers

`platform/fiab/bicep/modules/landing-zone/synapse-spark-pools.bicep` (wired into
the DLZ orchestrator `landing-zone/main.bicep`, feature flag
`deploySparkWorkloadTiers`, default `true`) adds workload-tiered pools alongside
the interactive `loompool` that `synapse.bicep` already deploys. Every pool is
**MemoryOptimized, autoscaling, autopause-on** (a paused pool reserves no nodes →
zero idle cost) and carries **baked best-practice Apache Spark config**.

| Pool | Tier | Node size | Autoscale | Autopause | Workload |
|------|------|-----------|-----------|-----------|----------|
| `loompool`  | Interactive | Small  | 3–10 | 15 min | Notebooks, interactive analytics (from `synapse.bicep`) |
| `loometl`   | ETL         | Medium | 3–12 | 15 min | Medallion transforms, production ETL |
| `loombatch` | Batch/ML    | Large  | 3–20 | 15 min | Heavy batch, wide shuffles, ML training |

Sizes/bounds are parameterized via the `sparkTiers` array param — override per
deployment without editing the module. IL5 sets `sparkPoolIsolatedCompute=true`
(dedicated physical hosts) automatically.

### Baked best-practice Spark config

The same values the console compute presets hand out
(`apps/fiab-console/lib/databricks/cluster-presets.ts` `BASE_CONF`/`DELTA_CONF`
and `apps/fiab-console/lib/spark/config-presets.ts`) are baked onto every tiered
pool via `sparkConfigProperties` (ARM `configurationType: File`), so
pre-provisioned compute matches the UI — and applies to **every** Spark
application, not just console notebook sessions:

```properties
spark.sql.adaptive.enabled true
spark.sql.adaptive.coalescePartitions.enabled true
spark.sql.adaptive.skewJoin.enabled true
spark.serializer org.apache.spark.serializer.KryoSerializer
spark.microsoft.delta.optimizeWrite.enabled true
spark.databricks.delta.optimizeWrite.enabled true
spark.databricks.delta.autoCompact.enabled true
```

- **AQE** (adaptive query execution) coalesces small shuffle partitions and
  switches/repairs skewed joins at runtime — so `spark.sql.shuffle.partitions`
  is left unpinned (AQE derives it).
- **Kryo** is the fast serializer.
- **Delta optimize-write / auto-compact** avoid the small-file problem on Delta
  writes. Both the Synapse-native key (`spark.microsoft.delta.optimizeWrite.enabled`)
  and the databricks-namespaced key are set so the config is correct whichever
  engine reads it.

---

## 2. Spark → Log Analytics telemetry

**Destination:** the standardized Loom Log Analytics workspace
(`law-csa-loom-<region>`). Tables:
`SparkLoggingEvent_CL` / `SparkMetrics_CL` / `SparkListenerEvent_CL`
(fine-grained per-application logs/metrics/listener events) and
`SynapseBigDataPoolApplicationsEnded` (one row per ended Spark application).

Two complementary layers:

| Layer | What it emits | How it is wired |
|-------|---------------|-----------------|
| **Pool diagnostic settings** (`BigDataPoolAppsEnded` + `AllMetrics`) | App-completion records + pool metrics | Bicep — `synapse-spark-pools.bicep` + `synapse.bicep` (`diag-loom-stdz`) |
| **Application emitter** (`spark.synapse.logAnalytics.*`) | Per-application executor/task logs, metrics, listener events | Bicep bakes it when a LA GUID is supplied; `scripts/csa-loom/wire-spark-telemetry.sh` is the primary applier (creates the KV secret first) |

### The LA shared-key secret (operator action to know)

The Log Analytics **workspace shared key** authenticates the Spark emitter
(Synapse Spark requires the workspace key — managed-identity-only auth is
**not** supported for LA ingestion). It lives **only** in the Loom Key Vault:

- **Key Vault secret name:** `SparkLogAnalyticsSecret` (override via
  `SPARK_LA_SECRET_NAME`).
- Populated idempotently by `wire-spark-telemetry.sh` from
  `az monitor log-analytics workspace get-shared-keys`. **The key is never
  inlined in bicep, printed, or written to disk.** Rotate it in Key Vault.

The **Synapse workspace managed identity** is granted `Key Vault Secrets User`
so it reads the secret at Spark-session start (Synapse "Option 2" — MSI-read
KV, no dev-plane linked service required). The console's per-session notebook
emitter uses the same key via the already-wired `LOOM_SPARK_LA_WORKSPACE_ID`
(= LA `customerId`) + `spark-la-key` container secret from
`admin-plane/main.bicep`.

### Data-exfiltration protection (honest gate)

The Synapse workspace runs in a managed VNet with
`preventDataExfiltration=true`. Spark egress to the LA ingestion endpoint
(`ods.opinsights.azure.com`, or `ods.opinsights.azure.us` in Azure Government)
is blocked unless a workspace **IP firewall rule / managed route** allows it.
`wire-spark-telemetry.sh` wires the config; if telemetry does not appear in Log
Analytics, add the LA egress allowance for the pool's managed VNet (Synapse
Studio → Manage → workspace IP firewall, or a managed private endpoint per the
Learn "collect logs with data-exfiltration protection" guidance).

`spark.synapse.logAnalytics.uriSuffix` is set per cloud automatically
(`ods.opinsights.azure.us` for GCC-High/IL5).

---

## 3. Databricks instance pools + cluster policy

`scripts/csa-loom/provision-databricks-compute.sh` (idempotent, list-then-create)
provisions, from the node types in `cluster-presets.ts`:

| Instance pool | Node type | Max capacity | Idle auto-term |
|---------------|-----------|--------------|----------------|
| `loom-pool-s` | `Standard_DS3_v2`   | 8  | 15 min |
| `loom-pool-m` | `Standard_E8ds_v4`  | 16 | 15 min |
| `loom-pool-l` | `Standard_E16ds_v4` | 32 | 15 min |

`min_idle_instances=0` (no idle cost) with spot-with-fallback and a preloaded
LTS Spark runtime for warm starts.

**Cluster policy "Loom Standard"** enforces the best-practice `spark_conf` (AQE,
skew-join, coalesce, Kryo, Delta optimize-write + auto-compact), an
auto-terminate range (10–120 min, no immortal clusters), the `loom-managed`
tag, and `cluster_log_conf` delivery to `dbfs:/cluster-logs/loom`.

**Databricks → Log Analytics** diagnostic settings (categories `clusters`,
`notebook`, `jobs`, `accounts`, `dbfs`, `unityCatalog`, `instancePools`,
`sqlanalytics`, …) are set on the workspace resource by
`landing-zone/databricks.bicep` and re-asserted idempotently by the script.

---

## 4. From-scratch provisioning steps

1. **Provision infra** — `az deployment sub create -f platform/fiab/bicep/main.bicep …`
   creates the Synapse workspace + `loompool` + the workload-tiered pools
   (`loometl`, `loombatch`) with baked best-practice config and pool diagnostic
   settings. Databricks workspace diagnostics land here too.
2. **Build + push app images, bring apps up** — `.github/workflows/full-app-deploy-commercial.yml`.
3. **Provision compute + telemetry** — either:
   - automatically, via the gated step in
     `.github/workflows/csa-loom-post-deploy-bootstrap.yml` (default-on; skip
     with repo var `LOOM_SKIP_COMPUTE_PROVISION=true`), **or**
   - standalone, via `.github/workflows/csa-loom-provision-compute.yml`
     (dispatch with region/subscription/boundary — safe to run against a live
     deployment).

   Both run, idempotently:
   - `scripts/csa-loom/wire-spark-telemetry.sh` — KV secret + workspace-MSI KV
     read + LA emitter/best-practice Spark config on every pool + workspace diag.
   - `scripts/csa-loom/provision-databricks-compute.sh` — instance pools +
     cluster policy + workspace diag.
   - `scripts/csa-loom/run-spark-storage-fix-invnet-job.sh` — the in-VNET
     Synapse managed PE to the default lake, so Spark reads don't hang (called
     automatically — not a manual step).

### Operator actions that may still be required

- **LA egress allowance** for the Synapse managed VNet if telemetry doesn't
  appear (data-exfiltration protection — see §2).
- The deploy SP must be a **Databricks workspace admin** (via SCIM bootstrap)
  for the instance-pool/policy REST calls, and hold **Log Analytics get-shared-keys**
  + **Key Vault Secrets Officer** for the telemetry secret write.
- The Loom Key Vault is private; the scripts open a **runner-IP-scoped** write
  window (`KV_TOGGLE_PUBLIC=1`) and always restore it. In-VNET execution avoids
  the toggle entirely.

---

## References (Microsoft Learn)

- [Microsoft.Synapse workspaces/bigDataPools — `sparkConfigProperties`](https://learn.microsoft.com/azure/templates/microsoft.synapse/workspaces/bigdatapools)
- [Monitor Apache Spark applications with Azure Log Analytics](https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-azure-log-analytics)
- [Available Apache Spark configurations (uriSuffix, Key Vault)](https://learn.microsoft.com/azure/synapse-analytics/monitor-synapse-analytics-reference)
- [Collect Spark logs with data-exfiltration protection](https://learn.microsoft.com/azure/synapse-analytics/spark/azure-synapse-diagnostic-emitters-azure-storage#synapse-workspace-with-data-exfiltration-protection-enabled)
- [Optimize write on Apache Spark](https://learn.microsoft.com/azure/synapse-analytics/spark/optimize-write-for-apache-spark)
- [Azure Databricks WAF — cost optimization (T-shirt-size compute, instance pools)](https://learn.microsoft.com/azure/well-architected/service-guides/azure-databricks)
