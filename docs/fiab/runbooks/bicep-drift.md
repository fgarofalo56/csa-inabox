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
- A `Modify` whose property `after` is an **unevaluated ARM expression** is
  neither drift nor noise — see [Unresolved](#unresolved).

<a id="unresolved"></a>
### Unresolved — a property what-if never evaluated (#2874)

what-if does not always evaluate the **template** side of a property. When the
template value is an ARM expression it cannot resolve — typically a
`reference()` into a resource this deployment is not re-evaluating — what-if
emits the expression *itself*, verbatim, as the delta's `after`. Measured on
the Gov (GCC-High) lane of run 33406666389, on the Sentinel Responder role
assignment. That resource's delta has **two** property entries, and the
distinction between them is the whole point:

```
Modify  .../workspaces/law-csa-loom-usgovvirginia/providers/Microsoft.Authorization/roleAssignments/0912013f-…
  properties.principalId      Modify     ← NOT COMPARED
    before "1feb8cae-15de-4f0f-9085-8863128949c9"          (the live principal GUID)
    after  "[reference(resourceId('Microsoft.Logic/workflows',
            format('la-csa-loom-ai-alert-{0}', parameters('location'))),
            '2019-05-01', 'full').identity.principalId]"    (never evaluated)
  properties.principalType    NoEffect   ← REAL, unmatched
    before null
    after  "ServicePrincipal"
```

`properties.principalId` is the unresolved one. `properties.principalType` is
**not** — it is a concrete value, `Microsoft.Authorization/roleAssignments` is
not in `whatif-noise-allowlist.json`, so it stays unmatched and **keeps this
resource in the drift verdict**. Classifying principalId as UNRESOLVED does not
turn this run green, and it was never meant to: it stops the verdict asserting a
conflict on a property what-if never compared, while the genuinely unmatched
sibling still fails the run.

Source of the expression: `platform/fiab/bicep/modules/admin-plane/ai-defense.bicep`
(`playbookSentinelResponder`, `principalId: playbook.identity.principalId`) —
**not** `azure-connections-rbac.bicep`, despite what the ledger note on the
issue said.

A GUID and an unevaluated expression are not two values that differ. They are
one value and a placeholder for it. Counting that as "the template and the live
estate disagree" asserts a conflict what-if never established — a
`deploy-integrity.md` R7 violation inside the verdict itself.

So the verdict script classifies it **UNRESOLVED**: a third bucket alongside
real drift and suppressed noise.

- **Never real drift** — it is not counted in `drift_count` and does not by
  itself fail the run.
- **Never silent** — every resource carrying an unresolved property is listed
  by resourceId in `unresolved-list.txt` and in the summary block as *"not
  compared by what-if"*, counted on the coverage line
  (`… ; N resource(s) with properties NOT COMPARED by what-if`), exposed as the
  `unresolved_count` / `unresolved_list` step outputs, and annotated with a
  `::warning::`. It is a **coverage gap**, in the same family as a
  short-circuited module.
- **Independent of the resource's verdict.** UNRESOLVED is a statement about a
  PROPERTY, not about a resource. A resource that also has a genuinely
  conflicting property — the real Gov case above — stays in the drift list on
  that property, *and* its uncompared property is still listed, counted, and
  named on the drift line itself (`(not compared by what-if: …)`). An earlier
  revision bucketed by resource alone and therefore printed `principalId`
  nowhere at all on this exact input, which was strictly less information than
  before the bucket existed.
- **Narrow by construction** — only a string of the form
  `[<function>(…)]` (optionally with a trailing `.property` / `[index]` chain)
  qualifies. `[[…]` (ARM's escape for a literal bracket), `["a","b"]`, `[0]`
  and any concrete value stay **real drift**.

Because a `Clean` verdict can now coexist with uncompared properties, the
lane's **auto-close** step requires `unresolved_count == 0` before it closes a
drift issue and says the estate matches IaC — otherwise it would assert a
coverage claim the run did not establish. A clean-but-uncompared run instead
files/updates an explicit coverage-gap report and leaves the issue open.

**Do not** "fix" the principalId delta by reseeding the GUID in
`ai-defense.bicep`: the principal is correct, and what-if still could not
evaluate `playbook.identity.principalId` afterwards. The only way to make the
property genuinely comparable is to stop deriving it from a `reference()` into
a conditionally-deployed resource, which is not worth doing for this
assignment.

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
4. A rule `path` may carry `*` for an ARM **array index** — and only that. `*`
   expands to `\d+`, so it matches `properties.logs.0.retentionPolicy.days`
   through `properties.logs.11.…` (and the bracket form, `subnets[3].type`) but
   **never** a property name. `properties.*` cannot be used to blanket a
   resource type. `whatif-drift-verdict.test.mjs` pins that narrowness — the
   `NARROWNESS` case asserts `properties.logs.AuditEvent.retentionPolicy.days`
   stays real drift.
5. Every suppression is printed — step summary, `suppressed-list.txt` in the
   artifact, and a collapsed section on the dedup issue.

**Adding an entry requires a reason grounded in the resource's ARM schema
(read-only, server-defaulted, or service-managed).** If a property is settable
and you want a specific value, encode it in bicep — do not allowlist it. When
bicep starts pinning a property, DELETE its allowlist entry in the same PR.

<a id="census"></a>
### The 2026-09-07 census of run 33406666389 (#3191)

The Commercial lane had been reporting a rising real-delta count — 124 (08-12),
126 (08-17), **128** (08-31) — with no per-property analysis behind it. The
number alone was not actionable, and the drift-list display made it worse (see
below), so the raw `whatif.json` from run 33406666389 was censused property by
property rather than read off the truncated summary.

Those 128 resources carried **357 unmatched property deltas.** The largest
families were all one shape — an RP-applied default repeated once per array
element or once per resource — and each was confirmed against its recorded
`before` value, not assumed:

| Deltas | Resource type | Path | Measured `before` |
|---|---|---|---|
| 27 | `privateDnsZones/virtualNetworkLinks` | `properties.resolutionPolicy` | `"Default"` |
| 33 | `Insights/diagnosticSettings` | `properties.{logs,metrics}.*.retentionPolicy.days` | `0` |
| 50 | `DocumentDB/…/containers` | `indexingPolicy.{included,excluded}Paths`, `backupPolicy`, `conflictResolutionPolicy.conflictResolutionPath` | `[{path:"/*"}]`, `[{path:"/\"_etag\"/?"}]`, `{type:1}`, `"/_ts"` |
| 40 | `privateEndpoints/privateDnsZoneGroups` | `privateDnsZoneConfigs.*.{id,etag,type,properties.provisioningState}` | read-only ARM metadata |
| 8 | `Network/privateEndpoints` | `properties.isIPv6EnabledPrivateEndpoint` | `false` |
| 4 | `ApiManagement/service` | `customProperties.…Security.[Backend.]Protocols.{Ssl30,Tls10,Tls11}` | `"False"` (the secure default) |

Allowlisting those took the verdict from **128 → 67 real resources** (11 → 72
suppressed). The Cosmos and diagnosticSettings families are the reason the
index wildcard had to exist: enumerating each index would have silently stopped
matching the day the estate grew one more container or log category.

**The display bug this exposed is worth more than the count.** `drift-list.txt`
shows at most six property paths per resource. On the APIM service those six
slots were entirely consumed by the four allowlistable `customProperties`
deltas, so the line read as four TLS toggles and two portal-status changes —
while `natGatewayState`, `publicNetworkAccess` and `releaseChannel`, all real,
were pushed off the end and had never been visible on any drift issue. Filtering
the noise at the source is what makes the residual list trustworthy; the count
is secondary. Regression-pinned by the `residual list stops hiding real deltas`
case in `whatif-drift-verdict.test.mjs`.

**What the remaining 67 are — and are NOT.** They are *not* uniformly real
drift, and this runbook does not claim they are:

- **28 resources carry at least one never-suppressible delta** (a `Create` or
  `Modify` on a property, or a whole-resource `Create`). These are genuine
  template-vs-live conflicts: AAS `asAdministrators`, the APIM policy bodies and
  `products/apis`, ACR `networkRuleSet.defaultAction`, KV `createMode`, the
  `managedEnvironments` block, 6 subnets' `privateEndpointNetworkPolicies`, a
  `virtualNetworkGateways` Create. Triage each per
  [Triage a drift finding](#triage-a-drift-finding); they need a reconciling
  change across many bicep modules, which is deliberately NOT bundled with the
  verdict-script change.
- **39 resources have a Delete-only residue** — further noise *candidates*
  (read-only properties on ML workspaces, NICs, bastion, `searchServices.endpoint`,
  `CognitiveServices/…/deployments.currentCapacity`). They are left in the
  verdict because no one has yet checked each against its ARM schema. **A
  candidate is not a finding**: do not allowlist them in bulk to make the number
  go down — that is exactly how a drift lane becomes a guard that cannot go red.
- One family in the residue is definitely real and must not be mistaken for the
  retention noise: `Delete:properties.logs.N` on 19 diagnosticSettings is a whole
  log *category* the template does not declare. Rule 2 keeps those resources in
  the verdict even though their retention leaves are now suppressed.

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
