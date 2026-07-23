# SLO & error budgets — reading the burn-down, first response to a breach

**Surface:** Admin → Health & Reliability → **SLO & error budgets** tab
(`/admin/health?tab=slo`, runtime flag `slo1-slo-tab`).
**API:** `GET /api/admin/slo` (tenant-admin) — the pure rollup in
`lib/admin/slo-rollup.ts` over three live feeds:

| SLI | Category | Feed | Objective (default) |
|-----|----------|------|---------------------|
| Synthetic journey availability | availability | V1 synthetic-journey verdicts (28-day window, `readSyntheticRuns`) | 99% of journeys pass |
| Copilot first-token latency | latency | `recentCopilotSloEvaluations()` (in-process window) | 95% under `LOOM_COPILOT_SLO_FIRST_TOKEN_MS` (5 s) |
| Copilot full-turn latency | latency | same | 95% under `LOOM_COPILOT_SLO_FULL_TURN_MS` (30 s) |
| Result-cache hit-rate | efficiency | `cacheCountersSnapshot()` (in-process) | 50% floor (never pages) |

This is the **in-product surface** for the SLO program. The RED SLI catalog and
multi-window multi-burn-rate alerting live in
`PRPs/active/enterprise-hardening/appendix-ops-slo-loadtest.md §1` — this tab
feeds that program, it is not a second one.

---

## 1. What the numbers mean

- **Objective** — the target fraction of good events (99% of journeys pass, 95%
  of turns under budget).
- **Attainment** — the observed fraction over the window (28 days for
  availability; the per-replica rolling window for the Copilot/cache SLIs — those
  reset on a roll and are read from whichever replica served the request).
- **Error-budget burn** — `actualFailRate ÷ allowedFailRate`. Below 1 is healthy
  (spending the budget slower than it refills). **2× or more** on an
  availability/latency SLI is a fast-burn breach: the 28-day budget is being
  consumed in ~14 days or faster.
- **Budget left** — `max(0, 1 - burn)`. Zero means the budget for the window is
  spent; further failures are pure debt until old failures age out of the window.
- **Burn-down sparkline** (availability only) — budget-remaining across the
  window's day buckets. A declining line means failures are accumulating; a flat
  line at the top means a clean window.

The **cache-hit SLI is an efficiency floor**, not an error budget — it renders a
bar but **never pages**. A collapsing hit-rate explains rising latency/cost; it
is not itself an incident.

## 2. When an SLI pages (P2 fast-burn)

The `/api/admin/slo` read dispatches ONE **P2** through the shared O1
alert-dispatch (`lib/azure/alert-dispatch.ts` → `LOOM_ALERT_ACTION_GROUP_ID`)
for each availability/latency SLI whose burn ≥ 2×, deduped per SLI
(`dedupKey: slo-burn:<sliId>`) and throttled to at most once per hour per
replica. The tab also shows an inline "N SLIs in fast-burn breach" banner.

First response, by SLI:

1. **Journey availability breach** — open the **Journeys** tab
   (`?tab=journeys`). A red **J1 with the rest green** = sign-in (MSAL) is broken
   while the app is healthy → rotate/verify the MSAL client secret first (the
   2026-07-19 outage class; see `msal-secret-outage` memory + the Secret &
   credential health pane). A specific editor journey red = that editor's backend
   is down → follow its own runbook (the journey `notes` name the failure).
2. **Copilot latency breach** — check AOAI throttling (`loom-copilot-throttling`
   runbook) and the tier-router latency-pressure state. A first-token breach with
   a healthy full-turn is usually streaming/ttft pressure; a full-turn breach is
   end-to-end (tool calls / retrieval).
3. **Confirm the budget recovers** — once the underlying fault is fixed, failures
   age out of the window over the next cycle(s); the burn falls back under 1 and
   the dedup clears on the next throttle window.

## 3. Tuning objectives

- Copilot budgets are env-tunable and **default-ON** with budget-matched
  defaults (`LOOM_COPILOT_SLO_FIRST_TOKEN_MS`, `LOOM_COPILOT_SLO_FULL_TURN_MS`,
  `LOOM_COPILOT_SLO_OBJECTIVE`) — they match the CI `perf-budgets.json` ceilings
  so the gate and the SLO never disagree.
- Availability + cache objectives are constants in `lib/admin/slo-rollup.ts`
  (`JOURNEY_AVAILABILITY_OBJECTIVE`, `CACHE_HITRATE_OBJECTIVE`,
  `FAST_BURN_ALERT_THRESHOLD`). SLO1 deliberately adds **no new env var** — a
  policy change is a code change with a review, not a runtime knob.

## 4. "No data" states (not incidents)

- **Synthetic-runs store not wired** — the availability SLI shows an honest
  info row naming the missing env (`LOOM_UAT_RESULTS_ACCOUNT` /
  `LOOM_UAT_RESULTS_CONTAINER`). Deploy `synthetic-monitor-job.bicep` (default-ON)
  and dispatch the `loom-synthetic-monitor` workflow once.
- **Copilot/cache SLIs empty** — those windows are per-replica and reset on a
  roll. Run a Copilot turn / issue a cached query and refresh; they fill from the
  process counters. An empty window is **met = true** ("no news is good news"),
  never a breach.

## 5. Reverting the surface

The tab is behind the FLAG0 runtime kill-switch `slo1-slo-tab` (default-ON).
Flip it OFF on **Admin → Runtime flags** to hide the tab in seconds (no roll) —
this also stops the `/api/admin/slo` read that dispatches the P2, so use it if a
misconfigured objective is paging spuriously while you fix the constant.

**Related:** `docs/fiab/runbooks/synthetic-journeys.md`,
`docs/fiab/runbooks/loom-copilot-throttling.md`, `docs/fiab/runbooks/on-call.md`,
`PRPs/active/enterprise-hardening/appendix-ops-slo-loadtest.md`.
