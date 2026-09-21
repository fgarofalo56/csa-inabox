# Blue-green console rolls (BR-BLUEGREEN)

> **SUPERSEDED FOR THE CONSOLE IN EVERY BOUNDARY, 2026-09-20.**
> `admin-plane/main.bicep` no longer declares `multiRevision: true` for
> `loom-console`, so the app renders **Single**-revision mode. `apps[]` is one
> list for every boundary, so this lands in Commercial, GCC, GCC-High and IL5
> alike — it is not a Commercial-only change, and per `cloud-parity.md` §4 it
> carries a **Commercial receipt only**: the live Commercial console was moved to
> Single and verified (43 active revisions → 1, healthy throughout). **No Gov
> boundary has been exercised**, and none should be listed as though it had.
>
> The workflow is now `disabled_manually` and recorded in
> `scripts/ci/workflow-lane-states-allowlist.json`. Read the next paragraph
> before re-enabling it.
>
> **RE-ENABLING THIS LANE IS NOW MORE DANGEROUS THAN IT WAS, not less.** It
> failed 4 of 4 runs at its *first* step, `Ensure multiple-revision mode`, on
> ARM's `ContainerAppInvalidIngressStickySessionRevisionMode` — ARM refuses that
> transition while ingress session affinity is set. **That failure was
> load-bearing**: it is the only thing that kept this lane from flipping the live
> console to Multiple. `app-deployments.bicep` now asserts `affinity:'none'` for
> every ingress app, which **clears that blocker** — so the step would now
> *succeed*, flipping the app to Multiple while `main.bicep` no longer declares
> `multiRevision: true` and no revision-retirement step exists. That restarts the
> accumulation described below. The lane is disabled for exactly this reason; a
> banner is not a control a `workflow_dispatch` can read.
>
> **Why it was reversed.** Multiple mode means `az containerapp update --image`
> creates a revision and deactivates nothing, and this roll's rollback
> re-updates the image rather than reactivating — so a *failed* roll added two.
> Nothing retired them. Measured 2026-09-20: **251 active revisions holding 484
> replicas** at `minReplicas: 2` apiece, **all Unhealthy**. New revisions
> provisioned cleanly (`provisioningState: Provisioned`,
> `provisioningError: null`) and then received **zero replicas against a floor of
> two** — placement failing, not provisioning, which ACA reports no error for.
> `Wait for revision health` timed out, auto-rollback landed on an equally
> starved revision, and the estate sat **11 commits behind for two days**.
> Confirmed causal by intervention: starved revisions took replicas the moment
> older ones were deactivated.
>
> Set against that, this lane has **never once succeeded** (4 runs, 4 failures,
> nothing since 2026-07-31 — the table below). The cost was being paid
> continuously for a capability that has never worked.
>
> **If you want this lane back**, restore `multiRevision: true` in
> `admin-plane/main.bicep` *and* ship revision retirement on the roll's success
> path first — otherwise the accumulation resumes immediately. Note also that
> `app-deployments.bicep` now asserts `affinity:'none'` for **every** ingress app
> rather than only `multiRevision` ones, so the sticky-session conflict this lane
> died on stays fixed either way.

**Status:** active but **UNVERIFIED** — see *Verification status* below ·
**Supersedes:** the in-place `az containerapp update --image` roll
(`gov-console-roll.yml` and manual `containerapp update`).

## Verification status (#3968) — read this before you reach for it in an incident

This is a **`workflow_dispatch`-only** path. `deploy-integrity.md` R3 treats a
deploy path that does not run as the loudest case of drift, not a silent pass, and
that is exactly the state this one is in.

Measured with `gh run list --workflow console-bluegreen-roll.yml`, 2026-08-29:

| run | date | conclusion |
|---|---|---|
| 30635466301 | 2026-07-31 | failure |
| 29812313317 | 2026-07-21 | failure |
| 29760624991 | 2026-07-20 | failure |
| 29529724362 | 2026-07-16 | failure |

**Four runs, four failures, nothing since.** All four failed in *Ensure
multiple-revision mode*, on ARM's `ContainerAppInvalidIngressStickySessionRevisionMode`
— blue-green requires multiple-revision mode, and ARM refuses that transition
while ingress session affinity is set.

**That cause has since been removed at BOTH layers, in code, and neither fix has
been exercised by a run of this workflow:**

1. **The template.** `admin-plane/app-deployments.bicep` now renders
   `ingress.stickySessions.affinity: 'none'` for any app carrying
   `multiRevision: true` (#3399), and `main.bicep` sets `multiRevision: true` for
   `loom-console` and nothing else. Before that change the property appeared
   NOWHERE in `platform/fiab/bicep`, so an affinity set out-of-band could not be
   cleared by any deploy — the template was neither setting nor unsetting the
   value it was conflicting with. That is also the answer to "why did the console
   move from Single to Multiple?": a deploy did it, deliberately, and the pairing
   is now self-healing on every re-render.
2. **The workflow.** The *Ensure multiple-revision mode* step no longer exits 1
   with an unexplained code: it classifies the read failure separately from the
   write failure, enters the sticky branch ONLY when ARM's own error names it,
   clears affinity to `none`, retries, and reports anything else verbatim as
   explicitly unclassified (R6/R7).

**So the July red is a fact about July, not about now — and "it probably works" is
not a receipt.** The only thing that settles it is a dispatch:

```
gh workflow run console-bluegreen-roll.yml -f cloud=commercial
```

Until that run exists and is green, treat this runbook as untested. If it fails,
record whether the cause is the July one (sticky / revision mode) or new.

**Gov is untested too, and separately so.** The `cloud` input offers `gov`, and
this workflow has never been dispatched against it. The bicep is cloud-invariant
— `apps[]` in `admin-plane/main.bicep` is one list for every boundary, so the Gov
console renders **the same Single-revision mode** the Commercial one now does,
and the same unconditional `affinity: 'none'` — but per `cloud-parity.md` §4 a
Commercial receipt proves nothing about Gov, and there is no Gov receipt for this
path at all. The 2026-09-20 move to Single was verified on the **live Commercial
console only**; Gov is supported-in-code and never exercised.

**After a first green run, this path needs a recurring smoke dispatch.** A runbook
whose correctness is only ever tested by an operator during an incident is not
tested. That schedule is deliberately NOT added here: it would roll the live
console on a timer, which is an estate-behaviour decision for the operator, not a
side effect of a documentation fix.

## Why

The old roll PATCHed the `loom-console` Container App image in **single-revision**
mode: the new revision immediately took 100% of traffic, so a bad image was an
**instant outage** until someone manually rolled the image back. Blue-green makes
a bad roll a **non-event** — the new revision only ever takes traffic after it
passes a health gate, and the prior revision stays warm as an instant rollback.

## How it works

`.github/workflows/console-bluegreen-roll.yml` (Commercial + Gov via the `cloud`
input) does, idempotently and non-interactively:

1. **Ensure multiple-revision mode** — `az containerapp revision set-mode --mode
   multiple` (no-op if already multiple). **As of 2026-09-20 the Console is NO
   LONGER pinned to multiple-revision mode in bicep**: `main.bicep` dropped
   `multiRevision: true`, so `app-deployments.bicep` renders
   `activeRevisionsMode: 'Single'` like every other app. This step therefore
   FIGHTS the template — it would flip the live app to Multiple, and the next
   infra redeploy would flip it back, with revisions accumulating in between.
2. **Capture blue** — the revision currently taking >0% ingress traffic (the
   rollback target).
3. **Build green** — `az acr build` the image server-side on the ACR (open public
   access → build → re-lock), same as `gov-console-roll`.
4. **Deploy green at 0%** — `az containerapp update --image … --revision-suffix
   g<sha>-<run>`. In multiple-revision mode the new revision is created with **0%
   traffic**; production stays on blue.
5. **Health-gate green** —
   - `properties.healthState == Healthy` (primary; always applicable), **and**
   - a probe to `https://<green-revision-fqdn>/api/version` confirming
     `build.sha` == the new SHA (proves the new image is actually serving, not
     just that the container is live). If green's per-revision FQDN isn't
     reachable from the runner (internal ingress), the gate falls back to
     healthState with a logged notice; a **reachable-but-wrong-SHA** hard-fails.
6. **Shift traffic** — only on a passing gate:
   `az containerapp ingress traffic set --revision-weight <blue>=0 <green>=100`.
   Blue is retained at 0% for instant rollback.
7. **Auto-rollback** — on any gate failure traffic **never left blue**; the
   workflow deactivates the failed green revision and re-pins 100% to blue, then
   fails the run.

Grounded in Microsoft Learn — [Blue-green deployment in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/blue-green-deployment)
and [Traffic splitting](https://learn.microsoft.com/azure/container-apps/traffic-splitting).

## Running it

```
# Commercial
gh workflow run console-bluegreen-roll.yml -f cloud=commercial

# Gov (AzureUSGovernment)
gh workflow run console-bluegreen-roll.yml -f cloud=gov
```

Optional inputs: `resource_group` (blank → cloud default: Commercial
`rg-csa-loom-admin`, Gov `rg-csa-loom-admin-usgovvirginia`), `app` (default
`loom-console`), `health_retries` (default 24 polls × 30s).

The workflow builds from the checked-out ref (the SHA it rolls), so dispatch it
from the branch/tag you want live.

## Manual instant rollback

Because blue is retained at 0%, a post-switch problem is one command to revert:

```
az containerapp ingress traffic set -n loom-console -g <rg> \
  --revision-weight <blue-revision>=100 <green-revision>=0
```

List revisions + current weights with:

```
az containerapp ingress traffic show -n loom-console -g <rg> -o table
az containerapp revision list -n loom-console -g <rg> \
  --query "[].{name:name, active:properties.active, health:properties.healthState, created:properties.createdTime}" -o table
```

## One-time enablement on an already-deployed app

If a console was deployed before this change (single-revision), the workflow's
step 1 flips it to multiple-revision mode automatically on the first run. To do
it by hand:

```
az containerapp revision set-mode -n loom-console -g <rg> --mode multiple
```

## Notes / limits

- **Front Door / WAF** sit in front of the app's stable FQDN; traffic weights are
  applied at the ACA ingress behind them, so the switch is transparent to Front
  Door — no Front Door change per roll.
- **Shared state** (Cosmos, Redis result-cache, Storage) is shared by blue and
  green during the overlap window. Keep schema/serialization backward-compatible
  across a single roll (the Loom item/config shapes are additive), exactly as the
  in-place roll already required.
- This covers the **console** only. Background/worker apps stay single-revision
  (no user-facing traffic to split); use the existing deploy for those.
