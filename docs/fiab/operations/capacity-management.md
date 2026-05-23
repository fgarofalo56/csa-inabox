# Capacity management

CSA Loom doesn't have a single F-SKU billing unit (Fabric does).
Instead, the Loom Console synthesizes a **CU-equivalent** dashboard
from the underlying-service consumption.

## The CU-equivalent model

| Underlying Azure consumption | CU equivalent |
|---|---|
| Databricks DBU | 1 DBU ≈ 16 CU |
| Synapse Serverless DPU | 1 DPU ≈ 8 CU |
| ADX vCore-second | 1 vCore-second ≈ 1/60 CU |
| Power BI Premium memory-MB-hour | 1 MB-hour ≈ 1/1024 CU |
| AOAI TPM (tokens per minute) | 50,000 TPM ≈ 1 CU |
| Function invocations | negligible (~0 CU) |
| ADLS Gen2 storage | not counted (storage-only, not compute) |

These coefficients are approximations calibrated against Fabric F-SKU
F64 / F128 published throughput. They give customers a **single number
to plan against**, even though the underlying billing remains
separate.

## Capacity scaling

Console "Admin → Capacity" pane lets the customer adjust:

| Service | Scaling axis |
|---|---|
| Databricks SQL Warehouse | Small / Medium / Large / X-Large (Serverless tier auto-scales within bound) |
| Databricks classic clusters | Min/max nodes per cluster policy |
| ADX cluster SKU | Dev / Standard_D11_v2 / Standard_E16ds_v5 / etc. |
| Power BI Premium F-SKU | F4 / F8 / F32 / F64 / F128 / F512 |
| AOAI deployment TPM | Per-deployment quota allocation |
| APIM tier | Premium throughput tier |

Scaling actions:
- **Up**: instant (no downtime — Azure-native scaling)
- **Down**: scheduled (avoids interrupting in-flight workloads)
- **Audit**: every scale action logged → Activity Log → Sentinel (Gov)

## Pause / resume patterns

Most expensive consumption is Spark + ADX:

| Service | Pause method | Cost savings |
|---|---|---|
| Databricks all-purpose clusters | Auto-pause after idle minutes (cluster config) | ~70% DBU savings overnight |
| Databricks SQL Warehouse | Auto-suspend after idle minutes | ~70% DBU savings |
| ADX cluster | Stop cluster (CLI / Azure portal) | Compute cost → 0; storage cost continues |
| Power BI Premium capacity | Pause-capacity (Azure portal) | Full F-SKU $ → 0 while paused |
| AOAI provisioned throughput | De-allocate provisioned units | Saves vs PAYG when not in use |

Console Admin pane has one-click pause for the entire DLZ (pauses
Databricks + ADX + Power BI together; reads remain free; writes
fail until resume).

## Capacity overrun monitoring

Console "Monitoring → Capacity" pane shows:

- CU-equivalent over last 24h (sum of DBU + DPU + vCore-seconds +
  Power BI memory + AOAI TPM, weighted)
- Per-service breakdown (Databricks / ADX / Power BI / AOAI)
- Forecast vs budget
- Throttling events (per-service 429 / capacity-throttled events)

Alert rules deployed by `platform/fiab/bicep/modules/admin-plane/monitoring.bicep`:
- CU-equivalent > 80% of budget for 1h → low-sev alert
- CU-equivalent > 100% of budget for 1h → high-sev alert
- Per-service 429 rate > 5% → service-specific alert

## Forecasting

`fiab-capacity-forecast` (script in `platform/fiab/bicep/scripts/`)
projects CU-equivalent usage from the last 30 days. Run before
adjusting reservation purchases.

## Reservations

| Service | Reservation pattern |
|---|---|
| Databricks DBU | DBU Commit Units (1-year / 3-year); ~30-40% savings |
| ADX | Reserved instances (1-year / 3-year); ~30% savings |
| Power BI Premium F-SKU | Annual commit; ~40% savings vs PAYG |
| AOAI provisioned throughput | Provisioned managed throughput (PTU) reservations |
| Synapse Serverless | No reservations — pure pay-per-query |

## Per-boundary considerations

| Boundary | Gov premium delta vs Commercial |
|---|---|
| GCC | Same Azure Commercial pricing |
| GCC-High / IL4 | ~10-25% above Commercial list |
| IL5 (v1.1) | Same as GCC-H + HSM-CMK overhead |

## Runbook

- [Capacity overrun](../runbooks/capacity-overrun.md)

## Related

- [Cost management](cost.md)
- [Monitoring](monitoring.md)
- Parent: [Cost Management](../../COST_MANAGEMENT.md)
