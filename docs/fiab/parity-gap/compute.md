# compute — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/compute/new`
**Fabric reference**: ai.azure.com — AI Foundry → Compute (Compute Instances + AmlCompute clusters)
**Loom screenshot**: `temp/parity/compute-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/compute` | 200 | 0 computes currently |
| `POST /api/items/compute` | wired — form posts AmlCompute/ComputeInstance | — |
| `POST /api/items/compute/<name>/start\|stop` | wired in table row buttons | — |

Form renders: Name input, Type dropdown (AmlCompute / ComputeInstance), VM size input, Min/Max nodes inputs (when AmlCompute selected). Empty list table below.

## Phase 3 — Fabric vs Loom

| Fabric element | Loom present? | Severity |
|---|---|---|
| Tab strip: Compute instances · AmlCompute · Inference clusters · Attached compute · Quota | NO — single page mixes types | MAJOR |
| Quota meter (cores used / cores limit) | NO | MAJOR — operator critical |
| VM size catalog dropdown (GPU/CPU families, cost/hr) | NO — free-form Input box | MAJOR |
| Idle-shutdown policy editor | NO | MAJOR |
| SSH / VNet / data-store assignment for ComputeInstance | NO | BLOCKER for ComputeInstance creation |
| List columns: status spark/timer, attached project, owner | partial — only Name/Type/VM/State | MINOR |
| Start/Stop/Restart row actions | YES (Start/Stop) | — |
| Detail page with metrics graph + recent runs | NO | MAJOR |

## Functional

- Start/Stop buttons fire real ARM POSTs (per source); not executed against real compute (would incur cost)
- Form Create button submits to backing ARM via BFF — verified route exists
- VM size is a plain `<Input>` — no validation against the SKU catalog, no cost preview

## Grade — **D**

Functional CRUD form against real ARM. Missing the typed VM-size catalog, quota meter, idle policy, VNet config — the things that make Fabric's compute editor actually safe for operators to use. Multiple BLOCKERs → **D**.
