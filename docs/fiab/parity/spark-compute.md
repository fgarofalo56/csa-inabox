# spark-compute — parity with Fabric workspace "Spark settings" (Pool / Environment / Jobs)

Source UI:
- Fabric workspace **Spark settings** → https://learn.microsoft.com/fabric/data-engineering/workspace-admin-settings
- Azure Databricks **Pool configuration** → https://learn.microsoft.com/azure/databricks/compute/pools
- Azure Databricks **Compute / runtime** → https://learn.microsoft.com/azure/databricks/compute/configure
- Azure Databricks **Libraries** → https://learn.microsoft.com/azure/databricks/libraries
- Azure Databricks **Spark configuration** → https://learn.microsoft.com/azure/databricks/spark/conf

Loom surface: `lib/panes/spark-compute.tsx` (`SparkComputePane`), wired into the
workspace Settings drawer (`lib/components/workspace-settings-drawer.tsx`, tab
**Spark compute**). BFF: `app/api/admin/workspaces/[id]/spark/{pools,runtime,environment,jobs}/route.ts`.
Clients: `lib/clients/spark-config-client.ts` (orchestration) +
`lib/azure/databricks-scale-client.ts` (instance pools / libraries / spark-conf).
Store: Cosmos `workspace-spark-config` (PK `/workspaceId`).

Azure-native default — Databricks is the backend; **no Microsoft Fabric
capacity or workspace is required** (.claude/rules/no-fabric-dependency.md).

## Fabric / Databricks feature inventory → Loom coverage

### Pool tab
| Capability | Loom | Backend per control |
|---|---|---|
| Starter pool (pre-warmed, no config) | ✅ | `POST .../spark/pools {action:'starter'}` → Cosmos `pool.mode='starter'` |
| Custom pool — pin workspace to a pool | ✅ | `POST .../spark/pools {action:'select'}` → Cosmos `pool.mode='custom'` |
| Create instance pool (name, node type) | ✅ | `POST .../spark/pools {action:'create'}` → Databricks `POST /api/2.0/instance-pools/create` |
| Min idle / max capacity | ✅ | create spec `min_idle_instances` / `max_capacity` |
| Idle auto-termination minutes | ✅ | create spec `idle_instance_autotermination_minutes` |
| On-demand vs Spot availability | ✅ | create spec `azure_attributes.availability` |
| Live pool stats (idle / used) | ✅ | `GET /api/2.0/instance-pools/list` → `stats` |
| Delete pool | ✅ | `DELETE .../spark/pools?poolId=` → `POST /api/2.0/instance-pools/delete` |

### Runtime tab
| Capability | Loom | Backend per control |
|---|---|---|
| Databricks runtime version | ✅ | `GET /api/2.0/clusters/spark-versions` → ClusterSpec `spark_version` |
| Node family filter (VM category) | ✅ | `GET /api/2.0/clusters/list-node-types` `category` |
| Worker node type | ✅ | ClusterSpec `node_type_id` |
| Driver node type (or same as worker) | ✅ | ClusterSpec `driver_node_type_id` |
| Autoscale (min/max workers) | ✅ | ClusterSpec `autoscale` |
| Fixed worker count | ✅ | ClusterSpec `num_workers` |
| Persist as workspace default | ✅ | `POST .../spark/runtime` → Cosmos `runtime` |

### Environment tab
| Capability | Loom | Backend per control |
|---|---|---|
| PyPI package set | ✅ | Cosmos `environment.pypi`; `POST /api/2.0/libraries/install` |
| Maven coordinate set | ✅ | Cosmos `environment.maven`; install/uninstall |
| Live library status on a cluster | ✅ | `GET /api/2.0/libraries/cluster-status` |
| Install / uninstall on a live cluster | ✅ | `POST /api/2.0/libraries/{install,uninstall}` |
| Session-level (notebook-scoped) packages toggle | ✅ | Cosmos `environment.sessionLevelPackages` |
| No live cluster selected | ⚠️ honest-gate | MessageBar: pick a cluster; set is still persisted |

### Jobs tab
| Capability | Loom | Backend per control |
|---|---|---|
| Session idle termination (minutes) | ✅ | Cosmos `jobs.session_timeout_minutes` → ClusterSpec `autotermination_minutes` |
| Optimistic cluster admission | ✅ | `spark.databricks.optimisticAdmission` (via `buildJobSparkConf`) |
| Reserved driver cores | ✅ | `spark.databricks.driver.reservedCores` |
| Dynamic executor allocation | ✅ (mapped to autoscale) | ClusterSpec `autoscale`; honest note that `spark.dynamicAllocation.*` is unsupported on Databricks classic clusters |
| Preview of materialized `spark_conf` | ✅ | `GET .../spark/jobs` → `buildJobSparkConf` |

## Honest gates (⚠️ — full surface still renders)
- `LOOM_DATABRICKS_HOSTNAME` unset → `sparkConfigGate()` 503 `not_configured` with the exact env var to set + the "Allow pool creation" entitlement note.
- Sovereign cloud without Azure Databricks (GCC-High / DoD) → 503 `not_available_in_cloud`; the pane shows a MessageBar directing to the Synapse Spark pool path.

## Per-cloud
| | Commercial | GCC | GCC-High | DoD |
|---|---|---|---|---|
| Azure Databricks available | Yes | Yes | No | No |
| Instance Pools API | Full | Full | gate | gate |
| Behavior when unavailable | — | — | honest MessageBar | honest MessageBar |

## Backend wiring
- AAD bearer to resource `2ff814a6-3304-4ab8-85cb-cd0e6f879c1d` (Azure Databricks); Console UAMI must be workspace admin **and** hold "Allow pool creation".
- `LOOM_DATABRICKS_HOSTNAME` already injected by `platform/fiab/bicep/modules/admin-plane/main.bicep`; no new env var required.
- Cosmos `workspace-spark-config` created lazily by `cosmos-client.ts` (no ARM pre-step).

## Verification
- `npx tsc --noEmit` clean on all touched files (full project 0 errors).
- `databricks-scale-client.test.ts` — 9/9 green: instance-pool create/edit/delete/list REST contract, library install/uninstall, `buildJobSparkConf` purity (no `spark.dynamicAllocation.*` emitted).
- E2E (operator): with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, open a workspace → Settings → Spark compute → create a real custom pool (appears in the Databricks portal), save runtime/jobs (persist in Cosmos and apply on next cluster create). With `LOOM_DATABRICKS_HOSTNAME` unset, the honest MessageBar renders.
