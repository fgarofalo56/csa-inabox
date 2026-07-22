# Spark pools — FAULTED recovery, leaked sessions, and the name-wedge

**Surface:** Admin → Health & Reliability → **Spark pools** tab
(`/admin/health?tab=spark`, runtime flag `a10-spark-tab`).
**API:** `GET /api/admin/spark/health` (tenant-admin) — aggregates the warm
pool (`getPoolStatus()`), the ARM Spark-pool census (`listSparkPools()`), and a
live Livy session census per pool (`listLivySessions(..., detailed=true)`).

This runbook covers the three production incident classes the dashboard
detects, in the order you should diagnose them.

---

## 1. Quick diagnosis order

When notebooks fail with "Spark session entered terminal state 'error'" or
"session may have been recycled", check in THIS order (each step distinguishes
a different fault class):

1. **Livy `errorInfo` (`detailed=true`)** — the dashboard's session table shows
   it per session. `MAX_QUEUED_JOBS_PER_COMPUTE_EXCEEDED` = the pool's 200-job
   queue is jammed (leaked queued sessions, §3). Anything else terminal in
   ~22 s with `appId=null` and no driver log = likely FAULTED pool (§2).
2. **Session census by name** — many `loom-warmpool-*` sessions stuck
   `not_started`/`Queued`, or one stuck `busy` for hours = leak / busy-zombie
   (§3). The dashboard badges these as **leak candidate** / **busy zombie?**.
3. **Breaker state** — a "Suspect — breaker armed" badge means warm-session
   launches are repeatedly failing against a pool ARM still calls `Succeeded`.
   Trust the breaker over ARM: this is the runtime-fault flavor.
4. **Test a NEW pool name** before assuming capacity/quota (§4) — the
   job-service wedge keys on pool NAME and survives delete+recreate.

In-VNet probes (the Synapse dev/Livy API is private-endpoint-locked — a public
runner gets 403 and can masquerade as "no sessions"): use the
`.github/workflows/csa-loom-spark-probe3.yml` workflow on the
`[self-hosted, loom-aca]` runner, or the `loom-diag-probe` ACA Job
(admin RG; `SCRIPT_B64` env → node eval; no `az containerapp exec` rate limit).

## 2. FAULTED pool — delete + recreate (2026-07-12 incident)

**Symptom.** Every Livy session goes `not_started → error` in ~22 s with
`appId=null` and NO driver log, from an EMPTY pool; minimal (1 core/1 g) and
standard sizing both fail. `provisioningState` may still read **Succeeded** —
a Synapse Spark pool can enter a runtime-faulted state while its ARM resource
state stays green. Ruled out before recreating: session clog (empty pool),
quota (minimal fails too), Loom code (raw `{}`-conf session fails
identically), networking (managed PE reaches storage), the LA emitter.

**Fix — delete + recreate the pool (same config):**

```bash
az synapse spark pool delete \
  --name <pool> --workspace-name <ws> -g <rg> --subscription <sub> --yes

az synapse spark pool create \
  --name <pool> --workspace-name <ws> -g <rg> --subscription <sub> \
  --node-size Small --node-size-family MemoryOptimized \
  --enable-auto-scale true --min-node-count 3 --max-node-count 10 \
  --enable-auto-pause true --delay 15 \
  --spark-version 3.4
```

Re-probe on the fresh pool (expect `idle` for both minimal and standard
sizing; cold start ~2–3 min). If sessions on the recreated pool STILL never
leave `not_started` → §4 (name-wedge).

## 3. Leaked sessions & the reaper (#1796, 2026-07-14)

**Leak classes** (all shown as **leak candidate** rows in the dashboard —
untracked by the warm pool AND in a capacity-holding state):

- **Idle leak (#1796):** crashed runs/replicas left ~700 `idle` sessions
  holding executors → fresh sessions never started.
- **Queued-zombie leak (2026-07-14):** failed warm-pool attempts left 153
  `loom-warmpool-*` jobs stuck Queued → the pool's 200-job cap hard-rejected
  every new session (`MAX_QUEUED_JOBS_PER_COMPUTE_EXCEEDED`).
- **Busy zombie (2026-07-14):** one `loom-warmpool-*` session stuck `busy` for
  2 days holding **80 cores** on loombatch, starving the workspace vCore
  quota. It survived a Livy DELETE (200 but kept running) — only pool
  delete+recreate cleared it. Dashboard badge: **busy zombie?**.

**The reaper** (`spark-session-pool.ts::reapStaleSessions`, DEFAULT-ON, opt
out `LOOM_SPARK_POOL_REAP=0`) runs on every sweep/keep-warm tick and kills
sessions that are ALL of: reapable state (`idle`/`not_started`/`starting`/
`recovering`), untracked, un-heartbeated within the grace window, and observed
untracked for a FULL grace window. Pool-owned (`loom-warmpool-*`) sessions
stuck `busy` use an extended grace (4× normal, floor 2 h). Live notebooks are
protected by the keepalive heartbeat.

**Manual sweep now:** hit the keep-warm heartbeat (machine token):

```bash
curl -X POST "$LOOM_URL/api/internal/spark/keep-warm" \
  -H "Authorization: Bearer $LOOM_INTERNAL_TOKEN"
```

If leak candidates persist after two grace windows, kill them directly
(`DELETE {dev}/livyApi/versions/2019-11-01-preview/sparkPools/<pool>/sessions/<id>`)
— and if a busy zombie survives DELETE, treat the pool per §2.

## 4. The name-wedge — recreate under a NEW name (loompool → loompool2)

**History (2026-07-14).** After delete+RECREATE of `loompool` (same name),
sessions STILL never left `not_started` for an hour — while a same-SKU pool
with a NEW name (`loompool2`) started sessions in under 2 minutes. Synapse
job-service queue state keys on the pool **name** and survives resource
recreation.

**Fix — abandon the name:**

1. Create the replacement pool (same config, new name, e.g. `loompool2`).
2. Point Loom at it: set `LOOM_SYNAPSE_SPARK_POOL=<newpool>` on `loom-console`
   (Admin → Environment config, or `az containerapp update --set-env-vars`) —
   a new revision rolls.
3. Verify a session reaches `idle` on the new pool (dashboard or probe).
4. Delete the wedged pool.

**"Pool Succeeded but can't launch" has three known flavors** — FAULTED
(§2, 2026-07-12), quota starvation (a zombie holding the workspace vCores,
§3), and the name-wedge (§4). The dashboard's breaker/suspect badge fires on
all three; the Livy census tells them apart.

## 5. Warm pool & keep-warm quick reference

- The warm pool keeps `min` sessions warm (`LOOM_SPARK_POOL_MIN`, default 1);
  the external heartbeat (`/api/internal/spark/keep-warm`, 5-min GH schedule /
  ACA cron) drives the sweeper because in-process `setInterval` does not
  survive serverless CPU-throttling — background progress must happen inside a
  request (#1947 `reconcileWarmingSlots`).
- Cross-replica warm hand-off requires the Cosmos lease store (dashboard badge
  `lease store: cosmos`); `memory` means per-replica pools only.
- Per-group circuit breaker: exponential backoff on consecutive warm failures,
  15-min hard backoff on `MAX_QUEUED`. The dashboard surfaces `lastFailure`
  and the backoff deadline per pool.

## 6. Related

- Health hub tab: `/admin/health?tab=spark` (flag `a10-spark-tab`)
- `docs/fiab/runbooks/notebook-spark-hive-abfss.md` — Spark→lake networking
- `docs/fiab/runbooks/capacity-overrun.md` — workspace capacity
- Reaper + breaker implementation: `apps/fiab-console/lib/azure/spark-session-pool.ts`
- Incident PRs: #1889 (reaper/pre-warm), #1932/#1947 (keep-warm), #2026
  (breaker + queued-zombie + busy-zombie rules)
