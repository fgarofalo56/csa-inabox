# Bicep drift — live-estate what-if lanes (V5)

Closes the drift blind spot (loom-next-level ground-truth #11): before V5,
`bicep-whatif.yml` only what-if'ed `deploy/bicep/**` on PR — it never saw
`platform/fiab/bicep/**` (where ALL Loom/FiaB infra lives) and nothing ever
ran a what-if against the LIVE estates. A hand-portal change (an ACR
"allow unsigned" toggle, a firewall rule, a diagnostic setting) could silently
diverge from IaC forever.

## The two lanes

| Lane | Workflow | Trigger | Compares | Output |
|---|---|---|---|---|
| PR lane | `.github/workflows/bicep-whatif.yml` → `whatif-fiab` job | `pull_request` touching `platform/fiab/bicep/**` | the PR's template vs the **live Commercial estate** (centralus) | PR comment (`Bicep What-If: FIAB`) + run artifact with the full what-if JSON |
| Scheduled drift lane | `.github/workflows/loom-drift-check.yml` | weekly (Mon 07:17 UTC) + `workflow_dispatch` | `main` vs **both live estates** — Commercial (centralus, `commercial-full.bicepparam`) and Gov GCC-High (usgovvirginia, `gcc-high.bicepparam`, gov SP secrets) | step summary + artifact; on drift: shared-action-group notification + dedup GitHub issue |

The scheduled lane **is the per-cloud mechanism** — one job per estate, each
with its own creds, paramfile, region, and dedup issue
(`bicep-drift` + `drift-commercial` / `drift-gov` labels). Issues auto-close on
the next clean run.

## What counts as drift

`az deployment sub what-if --no-pretty-print` JSON, incremental mode:

- **Create / Delete / Modify** on a managed resource → **unmanaged drift**
  (fails the scheduled run, fires the alert, files/updates the dedup issue).
- **NoChange / Ignore** → clean. `Ignore` includes every live resource the
  template does not declare — incremental what-if never proposes deleting them.
- What-if **errors** also fail the run (verdict UNKNOWN) — an un-runnable
  what-if is itself a red state, not a pass.

### Deliberate exclusions

- **`deployAppsEnabled=false`** on every lane: the app plane (Container Apps)
  rolls continuously via `loom-roll-and-validate.yml` / `gov-console-roll.yml`
  with sha-tagged images that churn by design — including them would make every
  run "drift". The lanes cover the **infra** estate; app-plane drift is what
  the roll gate + `full-app-deploy-*.yml` already reconcile.
- Live overrides baked into the lanes: `location` (centralus / usgovvirginia),
  `loomVanityDomain=<your-console-hostname>` (Commercial),
  `adminEntraGroupId` from `FIAB_ADMIN_GROUP_ID` / `FIAB_GOV_ADMIN_GROUP_ID`.

## Alerting (rev-2 standard)

Drift/error notifies the ONE shared action group `loom-default-alerts`
(`monitoring-default-alerts.bicep::defaultActionGroup`, derived var
`LOOM_ALERT_ACTION_GROUP_ID`) via
`az monitor action-group test-notifications create` — the same call
`loom-synthetic-monitor.yml` uses. Email + subscription-Owner ARM-role
receivers are the only channels that exist today; O1 (unified
`alert-dispatch`) absorbs this call when it lands. The dedup GitHub issue is
the durable signal either way.

## Triage a drift finding

1. Open the run's step summary / `whatif-drift-<cloud>-<runId>` artifact —
   `drift-list.txt` has `changeType<TAB>resourceId`; `whatif.json` has full
   before/after payloads per resource.
2. Classify each delta:
   - **Portal change never encoded** (the SC1 class: ACR toggles, firewall
     rules, RBAC done by hand) → open a **reconcile PR** that encodes the live
     state into `platform/fiab/bicep/**`. The PR lane then shows the delta
     going to zero.
   - **Accidental live change** → redeploy IaC over the estate
     (`deploy-fiab-commercial.yml` / `deploy-fiab-gcch.yml`, whatif-only first).
   - **IaC merged but never deployed** → run the deploy path; no code change.
   - **What-if false positive** (ARM what-if has known noisy properties) or a
     deliberate divergence with a reconcile PR in flight → append a
     `--parameters k=v` override via the repo variable
     `LOOM_DRIFT_EXTRA_PARAMS` (Commercial + PR lane) /
     `LOOM_DRIFT_EXTRA_PARAMS_GOV` (Gov), or the `extra_parameters` dispatch
     input for a one-off. Leave a comment on the drift issue naming the
     suppression and why.
3. The dedup issue auto-closes on the next clean weekly run (or dispatch
   `loom-drift-check.yml` after the fix for an immediate receipt).

## IL5 / air-gapped (design constraint only — do not build)

The what-if runs from the in-enclave `gh-aca-runner` KEDA job against the
sovereign ARM endpoint; no `api.github.com` → the GitHub-issue dedup is
replaced by an in-boundary report (Cosmos row + the admin Health hub) and the
alert sink stays in-tenant. The what-if verbs themselves are identical.

## Cost

~$0 — CI minutes only (one weekly what-if per estate + per-PR what-ifs on
infra PRs). No new Azure resources, no new env vars, no new alert channels.
