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

`az deployment sub what-if --no-pretty-print` JSON, incremental mode, **passed
through `scripts/ci/whatif-drift-verdict.mjs`** (both lanes share it):

- **Create / Delete / Modify** on a managed resource that survives the noise
  filter → **unmanaged drift** (fails the scheduled run, fires the alert,
  files/updates the dedup issue).
- **NoChange / Ignore** → clean. `Ignore` includes every live resource the
  template does not declare — incremental what-if never proposes deleting them
  — *and* every resource inside a short-circuited module (see
  [Coverage](#coverage)).
- What-if **errors** also fail the run (verdict UNKNOWN) — an un-runnable
  what-if is itself a red state, not a pass.

### The raw `changeType` is NOT a verdict — what-if noise

ARM what-if reports a property as *deleted* whenever the live resource carries
a value the template does not declare — **including read-only properties and
server-applied defaults that a redeploy re-applies verbatim.** Microsoft says so
outright:

> Some of the properties that are listed as deleted won't actually change.
> Properties can be incorrectly reported as deleted when they aren't in the
> Bicep file, but are automatically set during deployment as default values.
> This result is considered "noise" in the what-if response.
> — [Bicep what-if](https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-what-if)

The very first scheduled run (30259654971, issue #2540) filed **11 "deltas" that
were 100% this class**: nine identical
`Microsoft.ManagedIdentity/userAssignedIdentities` reports of
`properties: {isolationScope:"None"}` (the RP default — `identity.bicep` declares
no `properties` block at all, so all nine UAMIs report the same thing), plus
`Microsoft.Dashboard/grafana` `properties.grafanaMajorVersion` (service-managed
upgrade) and five Container-App server defaults on `loom-udf-runtime`
(`runningStatus`, `workloadProfileName`, `configuration.maxInactiveRevisions`,
`configuration.ingress.traffic`, `configuration.ingress.exposedPort`). *Nine
identical deltas are never nine hand-edits* — that shape is the tell for a
systematic RP-side property.

**A detector that cries wolf is worse than none**, so the noise is filtered at
the source, not acknowledged per-run:

| Mechanism | File | Use for |
|---|---|---|
| Noise allowlist | `scripts/ci/whatif-noise-allowlist.json` | read-only / server-defaulted properties, per resource type, each with a schema-grounded `reason` |
| Verdict + coverage | `scripts/ci/whatif-drift-verdict.mjs` | applies the allowlist, emits the summary, reports the coverage gap, exits 1 on real drift |
| Param overrides | repo vars `LOOM_DRIFT_EXTRA_PARAMS` / `..._GOV`, dispatch `extra_parameters` | a *deliberate parameter divergence* while a reconcile PR is in flight |

The filter is deliberately hard to abuse:

1. Only `propertyChangeType` **Delete / NoEffect** is suppressible. A `Create`
   or `Modify` on a property is a genuine template-vs-live conflict and is
   never suppressed.
2. A resource drops out of the verdict only when **every** one of its property
   deltas is allowlisted. One unmatched delta keeps the whole resource as drift.
3. Entries may carry `whenBeforeKeysSubsetOf` so that suppressing a whole
   `properties` object cannot hide a future settable property (this is how the
   UAMI entry is scoped to `isolationScope` + the read-only ids).
4. Every suppression is printed — step summary, `suppressed-list.txt` in the
   artifact, and a collapsed section on the dedup issue.

**Adding an entry requires a reason grounded in the resource's ARM schema
(read-only, server-defaulted, or service-managed).** If a property is settable
and you want a specific value, encode it in bicep — do not allowlist it. When
bicep starts pinning a property, DELETE its allowlist entry in the same PR.

<a id="coverage"></a>
### Coverage — what-if does not see the whole estate

`platform/fiab/bicep/main.bicep` passes module outputs into downstream modules.
what-if cannot evaluate those params outside a real deployment, so it
**short-circuits** the module and skips every resource inside it, emitting a
`NestedDeploymentShortCircuited` diagnostic
([Learn](https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-what-if#short-circuiting)).
Those resources come back as `Ignore` — indistinguishable, in the raw counts,
from "not in the template".

On run 30259654971 that was **38 short-circuited modules — `network`,
`keyvault`, `loom-console-cosmos`, `registry`, `container-platform`, `ai-search`,
`ai-foundry`, `apim`, `adx-cluster`, `aas-server`, `monitoring`, `vpn-gateway`
and the RBAC modules — leaving only 18 of 235 resources actually compared.**
A bare "zero deltas" verdict would have been a much larger claim than the data
supports.

The verdict script therefore always prints
`evaluated N; K Ignore; M nested deployment(s) short-circuited` and lists the
short-circuited modules in the summary, the PR comment, and the dedup issue.
This is reported, not failed — it is a structural property of a
module-composed template, not an estate problem. Narrowing it means reducing
`reference()`-derived module params (pass resource *names* and use `existing`
in the child) — worth doing opportunistically for the security-relevant modules
(`keyvault`, `network`, `registry`), not worth a rewrite. Until then, treat the
drift lane as **high-signal for what it covers and silent for what it cannot**;
the deploy lanes and the RBAC/network posture guards are the compensating
controls.

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
   `drift-list.txt` has `changeType<TAB>resourceId<TAB>[unmatched property
   deltas]` (real drift only), `suppressed-list.txt` has what the noise filter
   dropped and why, and `whatif.json` has full before/after payloads per
   resource plus the `diagnostics[]` array. **Read the property paths before
   concluding anything** — the resource id alone never tells you whether a
   Modify is real.
2. Classify each delta:
   - **Portal change never encoded** (the SC1 class: ACR toggles, firewall
     rules, RBAC done by hand) → open a **reconcile PR** that encodes the live
     state into `platform/fiab/bicep/**`. The PR lane then shows the delta
     going to zero.
   - **Accidental live change** → redeploy IaC over the estate
     (`deploy-fiab-commercial.yml` / `deploy-fiab-gcch.yml`, whatif-only first).
   - **IaC merged but never deployed** → run the deploy path; no code change.
   - **What-if noise** (read-only / server-defaulted / service-managed
     property, `propertyChangeType: Delete`) → add an entry to
     `scripts/ci/whatif-noise-allowlist.json` with a schema-grounded reason.
     Tell: several resources of the same type reporting the identical path.
   - **Deliberate parameter divergence** with a reconcile PR in flight →
     append a `--parameters k=v` override via the repo variable
     `LOOM_DRIFT_EXTRA_PARAMS` (Commercial + PR lane) /
     `LOOM_DRIFT_EXTRA_PARAMS_GOV` (Gov), or the `extra_parameters` dispatch
     input for a one-off. Leave a comment on the drift issue naming the
     suppression and why.
3. The dedup issue auto-closes on the next clean weekly run (or dispatch
   `loom-drift-check.yml` after the fix for an immediate receipt).

### Failure mode: what-if errors on `roleAssignments` (verdict UNKNOWN)

```
ERROR: InvalidTemplateDeployment - ... 'Authorization failed for template
resource '<guid>' of type 'Microsoft.Authorization/roleAssignments'. The client
'<deploy-SP>' ... does not have permission to perform action
'Microsoft.Authorization/roleAssignments/write' at scope '...'
```

This is **not drift** — it is the lane's own service principal lacking rights.
what-if runs with `--validation-level Provider` (the default), which
preflight-checks *deployment* permissions on every resource in the template, so
a deploy SP that cannot write role assignments fails the what-if before any
comparison happens. That is the correct red state (the SP could not run the
real deploy either), and the fix is an operator RBAC grant — **User Access
Administrator** (or Owner) on the subscription for the estate's deploy SP.
Do **not** paper over it with `extra_parameters`.

Seen 2026-07-27 on the Gov lane (issue #2541): SP `csa-loom-gov-deploy`
(`c63f4919-…`) could not write the `law-csa-loom-usgovvirginia` role assignment,
so the Gov estate has had **no drift coverage at all** since the lane landed.

Mitigated in the lane (2026-07-28): both drift jobs now pass
`--validation-level ProviderNoRbac` (az ≥ 2.76.0, probed at runtime) — full
template + resource validation, without the deploy-permission preflight a
read-only comparison never needed. If the Gov what-if still errors after that,
the SP is missing *read* access and needs the grant above. Note the deploy lanes
(`deploy-fiab-gcch.yml`) still require the write permission — this only unblocks
drift detection.


## IL5 / air-gapped (design constraint only — do not build)

The what-if runs from the in-enclave `gh-aca-runner` KEDA job against the
sovereign ARM endpoint; no `api.github.com` → the GitHub-issue dedup is
replaced by an in-boundary report (Cosmos row + the admin Health hub) and the
alert sink stays in-tenant. The what-if verbs themselves are identical.

## Cost

~$0 — CI minutes only (one weekly what-if per estate + per-PR what-ifs on
infra PRs). No new Azure resources, no new env vars, no new alert channels.
