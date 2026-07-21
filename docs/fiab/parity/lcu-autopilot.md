# lcu-autopilot — LCU-Autopilot / self-driving FinOps (WS-10.1 / BTB-2)

Source UI: no direct competitor analog — this is a burn-the-box differentiator.
Closest references: Azure Advisor cost recommendations + Azure Cost Management
budgets/anomalies, AWS Compute Optimizer / Trusted Advisor idle-resource
findings, and Databricks/Snowflake auto-suspend. Loom fuses a single normalized
LCU currency, live per-compute idle telemetry, and the gate/self-audit signal
into ONE closed loop that both *recommends* and *self-executes* the FinOps
action (pause idle compute / roll capacity config) — with an approval gate,
hysteresis, and a full audit trail — which no single-product competitor ships.

Admin surface: `/admin/autopilot` → `lib/components/admin/lcu-autopilot-pane.tsx`
Backends:
- `lib/admin/lcu-autopilot.ts` — the PURE policy engine (thresholds + hysteresis, unit-tested)
- `lib/admin/lcu-autopilot-loop.ts` — signal reader + actuator (chargeback + Azure Monitor + ARM pause/stop + `env-apply`)
- Routes: `app/api/admin/autopilot/route.ts` (GET status + PUT mode), `.../run/route.ts` (POST run), `.../apply/route.ts` (POST approve+self-execute)

## Feature inventory → Loom coverage

| Capability | Loom | Backend per control |
|---|---|---|
| Unified LCU + $ telemetry per compute resource | ✅ | `getChargebackModel` (Cost Management + Azure Monitor, published LCU coefficients) → `collectAutopilotSignals` |
| Live idle detection over a sustained window | ✅ | `fetchMetrics` DWUUsedPercent (Synapse pool) / CPU (ADX) over PT2H@PT15M → trailing-idle minutes |
| Lifecycle state per resource | ✅ | `getPoolState` (Synapse), `getKustoClusterArm` (ADX) |
| Gate / self-audit signal folded into the policy | ✅ | `allGateStatuses()` blocked-gate count |
| Policy: pause-idle recommendation with real $ saved | ✅ | `deriveAutopilotRecommendations` rule 1 (idle util ≤ threshold + sustained + $ worth it, cooldown-guarded) |
| Policy: capacity right-size (env-config roll) | ✅ | rule 2 — over-provisioned `LOOM_CAPACITY_LCU` env ceiling → roll to peak + 25% |
| Policy: migrate (advisory) | ⚠️ advisory | rule 3 — deeply-idle expensive ADX → advisory only, never auto-actuated |
| Hysteresis (anti-flap) | ✅ | sustained-idle window (`idleMinMinutes`) + per-target 6h `cooldownMs` |
| Auto-pause idle compute (real ARM) | ✅ | `pausePool` (Synapse) / `stopKustoCluster` (ADX) — releases compute, data survives |
| Env-config revision roll as actuator | ✅ | `applyEnvChanges({ LOOM_CAPACITY_LCU }, action:'lcu-autopilot.right-size')` → real ACA revision |
| Approval model (propose default / auto opt-in) | ✅ | Cosmos `autopilot` state doc, `DEFAULT_AUTOPILOT_MODE='propose'`; `setAutopilotMode` audited |
| Self-executing FinOps rec on approval | ✅ | `applyAutopilotRecommendationById` → executes the rec even in propose mode |
| SLO guard (never actuate under a latency incident) | ✅ | `sloBreaching()` blocks auto-actuation |
| Full audit trail | ✅ | `emitAuditEvent` (SIEM) + Cosmos `audit-log` row per actuation |
| Action history + $ impact UI | ✅ | GET dry-run (propose + non-persist) → tiles + recommendation cards + history table |

## Honest gates (G2)

- **LCU cost telemetry unavailable** — when Cost Management is not readable, the
  pane shows a warning MessageBar with the exact remediation (grant the Console
  UAMI *Cost Management Reader* + set `LOOM_SUBSCRIPTION_ID`) and an inline
  **Fix it → env-config** button. The gate `svc-lcu-autopilot` is `optionalDefault`
  (propose mode + auto-derived ceiling are the fully-functional defaults) so it
  never day-one-blocks (`no-fabric-dependency` / `loom_default_on_opt_out`).

## No-Fabric / sovereign

Azure-native only: Synapse Dedicated SQL pool + ADX cluster (Gov-available),
Cost Management, Azure Monitor, Container Apps revision roll. No Fabric/Power BI
host on any path.

## Owed

- Browser-E2E receipt (G1): auto-pause an idle Synapse/ADX resource + approve a
  FinOps recommendation end-to-end (Track-0), on a deployment with a bound
  Synapse pool / ADX cluster.
