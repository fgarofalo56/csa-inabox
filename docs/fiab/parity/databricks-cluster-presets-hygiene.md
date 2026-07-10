# databricks-cluster-presets-hygiene — parity with Azure Databricks compute + cluster management

Source UI:
- Azure Databricks → Compute → Create compute (policy / T-shirt-size presets, node type, autoscale, Photon, auto-terminate, Spark config, tags):
  https://learn.microsoft.com/azure/databricks/compute/configure
  https://learn.microsoft.com/azure/databricks/compute/cluster-config-best-practices
- Azure Databricks → Compute list (state, source, activity, terminate / permanently delete):
  https://learn.microsoft.com/azure/databricks/compute/clusters-manage
- WAF cost optimization (right-size compute, standardized T-shirt-size policies, auto-terminate 30–60 min, Spot for jobs):
  https://learn.microsoft.com/azure/well-architected/service-guides/azure-databricks#cost-optimization

## Feature inventory (Databricks compute)

| # | Capability | Where in the real UI |
|---|------------|----------------------|
| 1 | Create compute from a right-sized policy / T-shirt size | Create compute → Policy |
| 2 | Node type + driver node type | Create compute → Worker/Driver type |
| 3 | Autoscale min/max, or fixed workers | Create compute → Autoscaling |
| 4 | Single-node cluster (dev/test) | Create compute → Single node |
| 5 | Photon acceleration | Create compute → Performance |
| 6 | Auto-terminate after N idle minutes | Create compute → Auto termination |
| 7 | Spot / on-demand mix | Create compute → Advanced → Instances |
| 8 | Curated Spark config (AQE, skew join, serializer) | Create compute → Advanced → Spark config |
| 9 | Cost-allocation tags | Create compute → Tags |
| 10 | Cluster log delivery | Create compute → Advanced → Logging |
| 11 | List all clusters with state + source + last activity | Compute list |
| 12 | Terminate (stop) a cluster | Compute list → ⋯ → Terminate |
| 13 | Permanently delete a cluster | Compute list → ⋯ → Delete |

## Loom coverage

| # | Coverage | Notes |
|---|----------|-------|
| 1 | ✅ | `CLUSTER_TIERS` (std-xs-single-node / std-s / std-m-photon / std-l-photon / std-xl-photon) — tier cards in the cluster editor + a Size selector in the compute-picker New-cluster dialog. Tier ids match the operator's canonical workspace cluster names. |
| 2 | ✅ | Node type + driver node type dropdowns (real `list-node-types`); tiers set the worker node type. |
| 3 | ✅ | Autoscale min/max or fixed workers; tiers seed autoscale bounds. |
| 4 | ✅ | XS tier = real single-node recipe (num_workers 0, `spark.databricks.cluster.profile=singleNode`, `spark.master=local[*]`, `ResourceClass:SingleNode`). |
| 5 | ✅ | Photon toggle; M/L/XL tiers enable it. |
| 6 | ✅ | Auto-terminate field; **every tier ALWAYS sets it** (30–60 min interactive, ≤20 min jobs) — no immortal clusters. |
| 7 | ✅ | Spot toggle; Jobs workload flavor uses `SPOT_WITH_FALLBACK_AZURE` (driver on-demand). |
| 8 | ✅ | Structured key/value Spark-config builder; tiers bake AQE + coalesce + skew-join + Kryo (+ Delta optimize-write/auto-compact on Photon tiers). No freeform JSON. |
| 9 | ✅ | Tag rows; tiers stamp `loom-managed`, `loom-preset`, `loom-workload` (compute-picker path adds `loom-size`). |
| 10 | ⚠️ | Honest gate — injected server-side only when `LOOM_DATABRICKS_CLUSTER_LOG_PATH` is set (`databricksClusterLogConf`), else created without log delivery. |
| 11 | ✅ | Cluster-hygiene tab lists every cluster with state, source, idle-days, Loom-managed / preset badge, stale flag. Backend `GET /api/items/databricks-cluster/hygiene`. |
| 12 | ✅ | Multi-select → Terminate (real `clusters/delete`). |
| 13 | ✅ | Multi-select → Delete (real `clusters/permanent-delete`), confirm-gated. |

Honest gate (⚠️): when the workspace is unbound (`databricksConfigGate`), the hygiene panel renders a Fluent MessageBar naming the exact env var to set, and the GET returns `{ ok, gate }` (200) rather than an error.

## Backend per control

| Control | Backend |
|---------|---------|
| Tier picker → Apply | client-side `clusterSpecFromTier` fills the form; Save → `POST /api/items/databricks-cluster` → `POST /api/2.0/clusters/create` |
| Compute-picker Size + New cluster | `POST /api/loom/compute-targets` → `createCluster` (tags `loom-managed`/`loom-preset`/`loom-size`, injects log conf) |
| Hygiene list | `GET /api/items/databricks-cluster/hygiene` → `listClusters` + `toHygieneRow` enrichment |
| Bulk Terminate | `POST /api/items/databricks-cluster/hygiene {action:'terminate'}` → `terminateCluster` per id |
| Bulk Delete | `POST /api/items/databricks-cluster/hygiene {action:'delete'}` → `permanentDeleteCluster` per id |

Zero ❌ — every inventory row is built ✅ or an honest gate ⚠️.
