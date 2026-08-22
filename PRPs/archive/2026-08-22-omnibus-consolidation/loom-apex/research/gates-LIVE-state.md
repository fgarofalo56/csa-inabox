# Zero-Gates + Model Fabric — LIVE state (Commercial, 11ea763b, 2026-07-24 eve)

Probed via minted tenant-admin session against `GET /api/admin/gates` (125 gates) and
`/api/admin/model-fabric`. This is the AUTHORITATIVE live picture — it differs from the
static audit's prediction (gates-zero.md), which is exactly why the live probe matters.

## Model Fabric — NOT broken, NOT gated ✅
`GET /api/admin/model-fabric` → **HTTP 200**, `servingGate: null` (AML workspace
`aml-workspace-01-dev` IS configured), `mode: auto`, `endpoints: 0`, `reasoningConfigured: false`.
The page renders an honest empty state, not an error. What the operator likely saw:
- **`reasoningConfigured: false`** — the reasoning tier the loop promotes into is unset.
  It reads tenant config `modelTiers.strong` FIRST, then env `LOOM_AOAI_STRONG_DEPLOYMENT`.
  Neither is set. **This is a model-selection decision (cost/behavior on live Copilot routing),
  so it's the operator's call — set it in the admin UI (no roll) or wire the env.**
  Available strong deployments on `aoai-csa-loom-centralus`: `gpt-5.6-sol`, `gpt-5.6-luna`,
  `gpt-5.6-terra` (vs the current `gpt-4o-mini` base). Recommendation: `gpt-5.6-sol` as strong.
- **`endpoints: 0`** — no Azure ML online endpoints deployed yet, so nothing to traffic-split.
  Expected until model-serving endpoints exist. Not a defect.

## Live gate registry: 125 total, 10 involuntary-red

### The 5 that are CORRECT as-is (deliberate opt-ins — keep OFF, documented)
`svc-loom-trino`, `svc-ducklake-catalog`, `svc-s3-gateway`, `svc-loom-migrate`,
`svc-loom-risingwave` — all `blocked` by design (heavy/opt-in infra). No action.

### The 5 REAL involuntary gates — all trace to undeployed services + one missing action group
All are `warnOnMiss: true` (surface as amber, not hard-fail), several `derived: true`.
**None is a simple safe env flip that fully resolves — each needs infra or a deployed service:**

| Gate | Missing | Root cause | Fix (which apex item) |
|------|---------|-----------|----------------------|
| `svc-alert-action-group` | `LOOM_ALERT_ACTION_GROUP_ID` | No `loom-default-alerts` action group exists (design intends one — see `svc-alerting` optionalDefault detail); only Smart-Detection + 3 unrelated AGs present | Create the AG (email + sub-Owner ARM-role receivers) + set env → **one AG + one env write; clears this + half of secret-expiry**. Low-risk but a production roll — do with operator visibility. |
| `svc-secret-expiry` | `LOOM_ALERT_ACTION_GROUP_ID` + `LOOM_SECRET_EXPIRY_WARN_DAYS` | Above AG + a pure config value (=30) + the S1 monitor Function (Y1-broken in this estate) | WARN_DAYS is safe config; the monitor itself = **B-FN Function→ACA migration** |
| `svc-synthetic-monitor` | `LOOM_SYNTHETIC_MONITOR_ENABLED` + `LOOM_UAT_RESULTS_ACCOUNT/CONTAINER` | ENABLED is config, but the V1 login probe needs the **Entra CA exclusion** (operator-pending) to not alert-storm on blocked sign-in; results storage exists (ADLS) | Operator: CA exclusion → then enable. Don't flip blind. |
| `svc-copilot-evaluator` | `LOOM_COPILOT_EVALUATOR_URL` | Evaluator Function not deployed as an ACA service here | **B-FN Function→ACA migration** |
| `svc-transform-runner` | `LOOM_TRANSFORM_RUNNER_URL` | dbt+SQLMesh runner not deployed (`derived`) | **B-FN** — deploy the transform-runner ACA app + wire URL |

## Verdict for the hour window
- **Model Fabric works** — its only "issue" is the unconfigured reasoning tier, a model-choice
  I deliberately did NOT set autonomously (live FedRAMP Copilot routing + cost). One-liner for you.
- **8 of 10 red gates are correct** (5 opt-in) **or blocked on operator/infra** (CA exclusion,
  the shared action group, and the 3-service Function→ACA migration).
- I did **not** mutate production env/infra autonomously: every remaining fix is either a
  behavior/cost change (reasoning model), an alert-wiring change (action group + roll), or the
  B-FN migration — all better done with you watching, and B-FN is already scoped in loom-apex.

## Ready-to-run (when you say go)
1. **Reasoning tier** (Model Fabric): admin UI → set `modelTiers.strong = gpt-5.6-sol` (no roll), OR
   `az containerapp update … --set-env-vars LOOM_AOAI_STRONG_DEPLOYMENT=gpt-5.6-sol` (one roll).
2. **Shared action group**: create `loom-default-alerts` (email + ARM-role receivers) →
   set `LOOM_ALERT_ACTION_GROUP_ID` + `LOOM_SECRET_EXPIRY_WARN_DAYS=30` in one env update →
   clears `svc-alert-action-group` and de-reds `svc-secret-expiry`.
3. **Synthetic monitor**: after the CA exclusion, set `LOOM_SYNTHETIC_MONITOR_ENABLED=true`
   + `LOOM_UAT_RESULTS_ACCOUNT/CONTAINER` (ADLS exists).
4. **copilot-evaluator + transform-runner**: apex **B-FN** (Function→ACA-jobs migration).

Applies to BOTH estates (Gov gate registry to be probed the same way at execution).
