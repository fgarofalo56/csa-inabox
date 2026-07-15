# Blue-green console rolls (BR-BLUEGREEN)

**Status:** active · **Supersedes:** the in-place `az containerapp update --image`
roll (`gov-console-roll.yml` and manual `containerapp update`).

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
   multiple` (no-op if already multiple). The Console is also pinned to
   multiple-revision mode in bicep (`main.bicep` `multiRevision: true` →
   `app-deployments.bicep` `activeRevisionsMode: 'Multiple'`) so the mode is
   durable across infra redeploys; every other app stays `Single`.
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
