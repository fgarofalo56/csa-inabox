# batch-pool — parity with Azure Batch (pools · jobs · tasks)

Source UI: Azure portal → Batch account → Pools / Jobs (blades)
Learn: https://learn.microsoft.com/azure/batch/batch-technical-overview
REST: https://learn.microsoft.com/rest/api/batchmanagement/pool ·
      https://learn.microsoft.com/rest/api/batchservice/

The Loom "Batch pool" item is an ADF-Studio-style navigator over the
deployment-pinned Azure Batch account (`LOOM_BATCH_ACCOUNT`). Pools are managed
over the ARM management plane; jobs + tasks over the Batch **data** plane
(Entra-auth, cloud-aware audience). Azure-native — no Microsoft Fabric.

## Azure feature inventory → Loom coverage

| Azure Batch capability                                  | Loom coverage | Backend (per control) |
|---------------------------------------------------------|---------------|-----------------------|
| List pools (VM size, alloc state, node counts)          | ✅ built       | `listPools` → ARM `GET .../pools` |
| Create pool — VM size (curated dropdown)                | ✅ built       | `createPool` → ARM `PUT .../pools/{n}` (`buildPoolBody`) |
| Create pool — fixed dedicated + low-priority/Spot nodes | ✅ built       | fixedScale in `buildPoolBody` |
| Create pool — formula-driven autoscale (preset DSL)     | ✅ built       | autoScale in `buildPoolBody`; `AUTOSCALE_PRESETS` |
| Delete pool                                             | ✅ built       | `deletePool` → ARM `DELETE .../pools/{n}` |
| List jobs (id, pool, state)                             | ✅ built       | `listJobs` → data-plane `GET /jobs` |
| Create job bound to a pool                              | ✅ built       | `createJob` → data-plane `POST /jobs` (`buildJobBody`) |
| Delete job                                              | ✅ built       | `deleteJob` → data-plane `DELETE /jobs/{id}` |
| List tasks in a job (state, exit code, command line)    | ✅ built       | `listTasks` → data-plane `GET /jobs/{id}/tasks` |
| Add task (command line) to a job                        | ✅ built       | `createTask` → data-plane `POST /jobs/{id}/tasks` (`buildTaskBody`) |
| Delete task                                             | ✅ built       | `deleteTask` → data-plane `DELETE .../tasks/{id}` |
| Account overview (quotas, endpoint, alloc mode)         | ✅ built       | `getBatchAccount` → ARM `GET` account |
| Drive a task per pipeline run (BatchExecute activity)   | ✅ built       | pipeline `BatchExecute` (Custom) activity |
| Missing account / no Entra auth                         | ⚠️ honest-gate | `not_configured` 503 names `LOOM_BATCH_ACCOUNT` + `batch.bicep` |
| Non-admin access                                        | ⚠️ honest-gate | `forbidden` 403 (DLZ tenant/domain admin) rendered distinctly |

Zero ❌. Cloud-aware Gov data-plane audience via `batchScope()`.

## Day-one wiring (the fix that made it "work at all")

`main.bicep`:
- `batchEnabled` defaults **ON** (opt-out) — a Batch account + auto-storage are
  free at rest; only pools (VM fleets) incur spend and are created on-demand.
- `byoExisting.batchAccount` / `batchRg` now **feed the deployed account name**
  into the Console env (`LOOM_BATCH_ACCOUNT` / `LOOM_BATCH_RG`), derived
  deterministically (`take('batchloom${uniqueString(singleDlzRg.id)}',24)`) to
  avoid the adminPlane→dpBatch dependency cycle. Previously unset, so the item
  honest-gated forever even when the Batch account was deployed.

## Verification

- `lib/azure/__tests__/batch-client.test.ts` — 16 tests (pool/job/task body
  builders, config gate, autoscale presets, `classifyBatchGate` 403 vs 503).
- Live E2E (operator/harness): open a **Batch pool** item with the account
  deployed → create a pool (fixed + autoscale), add a job against it, add a
  task, confirm state + exit-code surface, delete task/job/pool.
