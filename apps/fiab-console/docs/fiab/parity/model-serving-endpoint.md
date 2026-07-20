<!-- parity-doc-meta
Reviewed-on: 2026-07-20
Validated-against:
  - apps/fiab-console/lib/editors/model-serving-endpoint-editor.tsx
  - apps/fiab-console/lib/azure/model-serving-client.ts
  - apps/fiab-console/lib/azure/model-serving-item.ts
  - apps/fiab-console/app/api/items/model-serving-endpoint/**
-->

# model-serving-endpoint — parity with Azure ML managed online endpoints + Databricks Mosaic AI Model Serving

**Source UI:**
- Azure ML Studio → Endpoints → Real-time endpoints ([Learn: online endpoints](https://learn.microsoft.com/azure/machine-learning/concept-endpoints-online))
- Databricks → Serving ([Learn: model serving](https://learn.microsoft.com/azure/databricks/machine-learning/model-serving/))

**Backends (no-fabric-dependency.md):** Azure ML managed online endpoints is the **Azure-native DEFAULT** (works in Azure Government `*.api.ml.azure.us`). Databricks Mosaic serving is **opt-in** via `LOOM_MODEL_SERVING_BACKEND=databricks` + `LOOM_DATABRICKS_HOSTNAME`. No Microsoft Fabric / Power BI dependency.

## Azure / Databricks feature inventory → Loom coverage

| Capability (source UI) | Loom coverage | Backend / REST per control |
|---|---|---|
| List real-time endpoints + state | ✅ Overview tab + left explorer | `GET /onlineEndpoints` (AML) / `GET /api/2.0/serving-endpoints` (Databricks) |
| Endpoint detail (scoring URI, auth mode, state) | ✅ Details right rail | `GET /onlineEndpoints/{name}` / `GET /serving-endpoints/{name}` |
| Create endpoint from a registered model version | ✅ Deployments tab → Create | `PUT /onlineEndpoints/{name}` + `PUT .../deployments/blue` / `POST /api/2.0/serving-endpoints` |
| Compute size (VM SKU / workload size) | ✅ Instance type / Workload size field | deployment `properties.instanceType` / `workload_size` |
| Autoscale (min/max instances) | ✅ Scaling = Autoscale → min/max | deployment `scaleSettings.scaleType=TargetUtilization` |
| Manual scale (fixed instance count) | ✅ Scaling = Manual → Instances | deployment `sku.capacity` / `scaleSettings.scaleType=Default` |
| Scale-to-zero (Databricks) | ✅ Switch (Databricks path) | served-entity `scale_to_zero_enabled` |
| Blue/green traffic split | ✅ Split traffic dialog (validated 0–100, sums to 100) | `PUT /onlineEndpoints/{name}` traffic / `PUT .../config traffic_config.routes` |
| Deployments table (model, compute, scale, traffic, state) | ✅ Deployments tab | `GET .../deployments` / endpoint `config.served_entities` |
| Test / invoke (scoring console) | ✅ Invoke tab — real POST + round-trip latency | AML: `listkeys` + `POST scoringUri`; Databricks: `POST /serving-endpoints/{name}/invocations` |
| Monitoring — request latency | ✅ Monitoring tab (KPI tile + chart) | Azure Monitor `RequestLatency` on `.../onlineEndpoints` |
| Monitoring — requests per minute | ✅ Monitoring tab | Azure Monitor `RequestsPerMinute` |
| Monitoring — error rate (5xx) | ✅ Monitoring tab | Azure Monitor `RequestsPerMinute` filtered `statusCodeClass eq '5xx'` |
| Delete endpoint | ✅ Overview → Delete | `DELETE /onlineEndpoints/{name}` / `DELETE /api/2.0/serving-endpoints/{name}` |
| Honest gate + Fix-it when backend unset | ⚠️ HonestGate (gate `svc-model-serving`) with inline Fix-it wizard | `servingConfigGate()` → `LOOM_AML_WORKSPACE` / `LOOM_DATABRICKS_HOSTNAME` |
| Databricks endpoint-level Azure Monitor charts | ⚠️ Honest note (Mosaic has no Azure Monitor plane; per-request latency shown from Invoke) | — |

## Grade

Zero ❌. Every inventory row is built ✅ or an honest infra-gate ⚠️ (no stub banners). Azure-native default works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

**Owed:** browser-E2E receipt (create endpoint → split traffic 80/20 → invoke → live latency/error tiles) — Track-0 follow-up.
