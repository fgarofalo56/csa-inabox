# Failure recovery — classification, retry, and remediation

Every deployment failure belongs to exactly one of **eight classes**. The class
determines whether retrying can possibly help, whether the platform can fix it
itself, and what you should do.

This page is the reference for those classes and their remediations. It is
written so you can classify a failure from the ARM error code alone, without
reading a log.

> **`deploy-integrity.md` R7 — error messages must be true.** An error must not
> state as fact something it did not establish. "I could not reach the registry"
> and "the tag does not exist" are different answers and must never collapse
> into one. Where a message in this repo still gets that wrong, it is listed in
> [Messages you should not trust](#messages-you-should-not-trust) rather than
> left for you to be misled by.

---

## The eight classes

| Class | Meaning | Retry helps? | Platform can fix it? |
|---|---|---|---|
| **transient** | Azure was momentarily unable to serve the request | **Yes** — bounded, with backoff | n/a |
| **eventual-consistency** | The request was correct but a principal or resource has not replicated yet | **Yes** — longer backoff | n/a |
| **registration** | A resource provider is not registered in the subscription | After remediation | **Yes** — register, then retry once |
| **permission** | The deploy identity lacks a role | **No** | **Partly** — see below |
| **quota** | A limit was hit: cores, SKU availability, streaming units, index count | **No** — deterministic | **Partly** — SKU fallback |
| **config** | The template and the estate disagree: a name is taken, a CIDR collides, a singleton exists | **No** | **Mostly** — see below |
| **defect** | The template or a Loom script is wrong | **No** | No — open an issue |
| **unknown** | The error matched nothing above | **No — fail closed** | No |

> **`unknown` is not a pass and it is not `defect`.** An unclassifiable failure
> exits non-zero and says so. Silently treating an unknown failure as retryable
> is how a retry that cannot fail gets built.

---

## transient

**Signals:** `429`, `TooManyRequests`, `ServiceUnavailable`, `GatewayTimeout`,
`DeploymentActive`, `AnotherOperationInProgress`,
`ContainerAppOperationInProgress`, `RetryableError`, `OperationNotAllowed` whose
message names another in-flight operation.

**Retry policy:** up to 6 attempts, ~30 s apart with jitter, then **fail
closed**.

**What to do:** re-run the same command. If it fails identically 6 times it is
not transient — reclassify.

**Container Apps specifically.** Two revisions of the same app cannot be
provisioned concurrently. `ContainerAppOperationInProgress` means a previous
roll is still settling; serialize rather than parallelize. Do **not** cancel an
in-flight roll of the same SHA to start another — that produces exactly this
error and leaves the app mid-transition.

---

## eventual-consistency

**Signals:** `PrincipalNotFound`, `RoleAssignmentUpdateNotPermitted` against a
freshly created principal, `ManagedIdentityRoleAssignmentDelay`.

**Cause:** a managed identity or Entra group was created moments ago and has not
replicated to the RBAC service yet.

**Retry policy:** up to 8 attempts, ~15 s apart.

**What to do:** wait 5 minutes, re-run. The deploy is incremental and idempotent,
so a re-run resumes rather than restarts.

---

## registration

**Signals:** `MissingSubscriptionRegistration`, `NoRegisteredProviderFound`.

**Remediation — the platform performs this itself** when the deploy identity has
rights, then retries once. If it cannot, run:

```bash
for rp in Microsoft.App Microsoft.ContainerRegistry Microsoft.Databricks \
          Microsoft.Synapse Microsoft.Kusto Microsoft.Purview; do
  az provider register --namespace "$rp"
done

# Poll until every one reports Registered — registration is not instant.
az provider list --query "[?namespace=='Microsoft.App'].registrationState" -o tsv
```

---

## permission

**Signals:** `AuthorizationFailed`, `LinkedAuthorizationFailed`, `Forbidden`,
Key Vault `Forbidden`.

**Read the two apart.** `AuthorizationFailed` means the identity cannot perform
the operation. `LinkedAuthorizationFailed` means it can perform the operation
but cannot write the *role assignment* the operation implies — it needs
`Microsoft.Authorization/roleAssignments/write` at that scope. The remediations
are different.

| Situation | Remediation |
|---|---|
| Deploy identity lacks Contributor on the target subscription | `az role assignment create --assignee <deploy-principal> --role Contributor --scope /subscriptions/<sub-id>` |
| Deploy identity lacks User Access Administrator (cannot write role assignments) | Same, `--role "User Access Administrator"`. Loom writes RBAC as part of the deploy; without this the deploy cannot complete |
| Console managed identity lacks a role on a **brownfield adopted** resource | `bash scripts/csa-loom/grant-navigator-rbac.sh` with the `EXISTING_*` values exported — **including `_RG`**, or the script skips silently |
| Re-deploying and the grant already exists (`RoleAssignmentExists`) | Re-run with `skip_role_grants=true`. This is a **config** failure, not a permission one |
| Key Vault `Forbidden` on a Premium/HSM operation | The identity lacks `Microsoft.KeyVault/managedHsms/write`. Needs an elevated role — this is a tenant policy decision, not something the deploy can grant itself |

**A deploy identity cannot self-elevate.** If it lacks
`roleAssignments/write` at a scope, nothing it does can obtain it. Where you are
signed in as Owner, granting from your own session is the fix — that is a
platform-performable remediation and the deploy should attempt it. Where neither
holds, the command above must be run by someone who does.

---

## quota

**Signals:** `QuotaExceeded`, `SubscriptionOperationsLimitExceeded`,
`ResourceQuotaExceeded`, `SkuNotAvailable`, `LocationNotAvailableForResourceType`,
ACR agent-pool core quota.

**Retrying a quota error cannot help.** It is deterministic. Any retry loop that
does not classify will burn its full budget and then report "failed after N
attempts" without the word *quota* in it — see
[Messages you should not trust](#messages-you-should-not-trust).

| Symptom | What it is | Fix |
|---|---|---|
| `QuotaExceeded: standardDDSv5Family Cores, Location: <region>, Current Limit: 200, Current Usage: 196, Additional Required: 8` | The ACR-task agent pool has no cores for the image build | Raise the VM-family quota in the portal (Subscriptions → Usage + quotas → filter the family + region), or build without the dedicated pool |
| `QuotaExceeded` on a Databricks Premium workspace | Regional vCPU limit | Raise the quota or pick another region |
| `SkuNotAvailable` | The SKU is not offered in the target region | Pick a supported SKU or region |
| `LocationNotAvailableForResourceType` | The **service** is not offered in the region | Disable that service (`purviewEnabled=false`, `azureMapsEnabled=false`) and attach a cross-region instance later where supported |
| AI Search index quota | Free tier cannot host Loom's four indexes | Adopt a Basic or higher service, or create one |

**Check before you spend:**

```bash
az vm list-usage -l <region> -o table | grep -iE "DDSv5|Dv5|Standard"
```

---

## config

**Signals:** `VnetAddressRangeInUse`, `PrivateDnsZoneAlreadyExists`,
`EnterpriseTenantAlreadyExists`, `StorageAccountAlreadyTaken`,
`RoleAssignmentExists`, `InvalidTemplateDeployment` naming a SKU, image
`MANIFEST_UNKNOWN` / pull failure.

This is the **brownfield class**. Most of these mean *something already exists*
— which on a brownfield estate is normal and should be adopted, not fought.

| Code | Meaning | Fix |
|---|---|---|
| `EnterpriseTenantAlreadyExists` | A Purview account already exists in this tenant. Only one is allowed | Adopt it: `EXISTING_PURVIEW=<name>` (+ `_RG`, `_SUB`). No enable-flag override is needed — `provisionPurview` is already false for an `adopt` decision. See [Brownfield](brownfield.md#step-2-choose-adopt-or-create-per-service) |
| `PrivateDnsZoneAlreadyExists` | The `privatelink.*` zone exists — almost always a re-deploy after a partial failure | Delete the conflicting zone (`az network private-dns zone delete -n <zone> -g <rg>`) or deploy into a clean resource group. **There is no `existingPrivateDnsZones` parameter.** An earlier version of this runbook claimed one; it has never existed |
| `VnetAddressRangeInUse` | The hub CIDR collides, or the hardcoded `10.100.0.0/16` DLZ spoke CIDR does | Set `hubVnetCidr` to a free `/16`. The spoke CIDR is not settable from the root template today — see [Brownfield class C](brownfield.md#class-c-no-adoption-path-exists-today) |
| `StorageAccountAlreadyTaken` | Storage account names are globally unique | Change the deployment name prefix |
| `RoleAssignmentExists` | Re-deploy over existing grants | Re-run with `skip_role_grants=true`, or delete the conflicting assignment |
| `InvalidTemplateDeployment` on Container Apps in IL4/IL5 | Container Apps is not available at that impact level | Set `containerPlatform = 'aks'` in the parameter file |
| `MANIFEST_UNKNOWN` / image pull failure on a Container App | Phase 1 ran with `deployAppsEnabled=true` against an **empty** ACR | Re-run phase 1 with `deployAppsEnabled=false`, then run the image phase. See [Greenfield](greenfield.md#the-shape-of-a-greenfield-deploy) |
| `ResourceGroupNotFound` early in the app-deploy workflow | The workflow's `region` input does not match the region the estate is in, so it resolved `rg-csa-loom-admin-<wrong-region>` | Pass `-f region=<your-region>` explicitly |
| `ResourceGroupNotFound` on a multi-subscription DLZ | A sub-scoped deployment cannot create a resource group in a **remote** subscription | Pre-create the spoke resource groups: `bash scripts/csa-loom/bootstrap-dlz-rgs.sh` |

---

## defect

**Signals:** `InvalidTemplate`, `BadRequest` against Loom's own template, any
`scripts/csa-loom/*` or `scripts/ci/*` exiting non-zero for a reason not covered
above.

**Not your problem to fix.** Open an issue with the label `csa-loom` +
`csa-bug`, and attach:

```bash
az deployment operation sub list --name <deployment-name> \
  --query "[?properties.provisioningState=='Failed']" -o json
```

---

## unknown

Nothing matched. **This fails closed** — the deploy stops and reports the raw
ARM code with an explicit statement that it could not classify it.

If you hit one, that is a gap in this taxonomy. Attach the run and the ARM code
to a new issue so the class gets added.

---

## Diagnosing: get the class in three commands

```bash
# 1. Which deployment failed, and with what top-level code?
az deployment sub list \
  --query "[?starts_with(name,'csa-loom')] | [?properties.provisioningState!='Succeeded'].{name:name,state:properties.provisioningState,code:properties.error.code}" \
  -o table

# 2. The inner error — this is the one that carries the real ARM code.
az deployment sub show --name <deployment-name> --query "properties.error" -o json

# 3. Which module, and every failed operation under it.
az deployment operation sub list --name <deployment-name> \
  --query "[?properties.provisioningState=='Failed'].{type:properties.targetResource.resourceType,code:properties.statusMessage.error.code,msg:properties.statusMessage.error.message}" \
  -o json
```

Then match the code against the class sections above.

---

## Resuming after a failure

The deploy is an **incremental** ARM deployment. Re-running it after fixing the
cause resumes: already-created resources are left alone, the failed module is
retried, and nothing is destroyed.

```bash
# Same command as the original phase 1. Add the fix.
az deployment sub create -l <region> \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/<boundary>.bicepparam \
  -p adminEntraGroupId="$GROUP_ID" -p deployAppsEnabled=false \
  -p <the-fix>=<value>
```

Two exceptions:

- **A partially-created Private DNS zone or a taken global name** must be
  removed first — an incremental deploy will keep hitting the same conflict.
- **A hub that already exists** is guarded. To reconcile it via the workflow you
  must pass `allow_existing_hub=true`, and **`keep_resources=true`** — without
  the latter, `run_mode=full` runs a teardown step on success that deletes every
  `rg-csa-loom-*` resource group in the subscription.

---

## The retry harness

`scripts/ci/deploy-retry.mjs` is the only retry primitive, and
`scripts/ci/check-deploy-failure-handling.mjs` (merge-blocking, in
`loom-guardrails.yml`) fails the build if a new hand-rolled retry loop appears
**in a workflow it can see**.

> **Two limits on that sentence, both measured on this branch (#3017).**
>
> **1. Only two workflows use the harness.**
> `grep -l deploy-retry.mjs .github/workflows/*.yml` returns
> `deploy-fiab-commercial.yml` and `full-app-deploy-commercial.yml` — and
> nothing else. `grep -c deploy-retry .github/workflows/deploy-fiab-gcch.yml`
> returns **0**. Classification, bounded retry, `--remediate` and the
> `deploy-failure.json` artifact are **Azure Commercial only**. On Gov you
> classify by hand, from this page.
>
> **2. The guard is scoped by filename, not by behaviour.**
> `check-deploy-failure-handling.mjs:71` selects files with
> `/(^|[-_])(deploy|build|roll|rollback)/i`. Workflows that mutate Azure but
> whose names do not contain those words are invisible to it — including **13
> `gov-provision-*` workflows**. Spot-checked: `gov-provision-aisearch.yml`
> runs `az deployment group create`; `gov-provision-maps.yml` runs
> `az acr build`. On a broad definition of "mutates Azure" the split is 24 in
> scope / 36 out. This is the same shape as a name-based security guard that
> misses the routes it was written to cover: where the guard is the only
> control, a filename filter is not a control.

```bash
node scripts/ci/deploy-retry.mjs \
  --class-allow transient,eventual-consistency \
  --max-attempts 6 --backoff 30 --jitter 0.3 --wall-clock 20m \
  --step "provision" --artifact deploy-failure.json --remediate \
  -- az deployment sub create -f main.bicep …
```

- Retries **only** the classes named in `--class-allow`, and only if the
  taxonomy marks that class retryable. A quota denial is attempted once.
- **Fails closed** on budget exhaustion, wall-clock expiry, and `unknown`. The
  exit code carries the class.
- The **happy path costs nothing**: one invocation, no sleeps, immediate exit 0,
  and no failure artifact written.
- Nothing is discarded. There is no `2>/dev/null`, no `|| true`, no
  `continue-on-error`. stderr is captured and, on final failure, echoed in full.
- Writes `deploy-failure.json`: class, signal id, **what was established**
  (the literal strings matched and the line each was on), the remediation, and
  every attempt.

---

## What the platform fixes by itself

Per `auto-bind-by-default.md` §5, a remediation the platform *could* have
performed is a defect, not a helpful message.

| Failure | What happens |
|---|---|
| `MissingSubscriptionRegistration` / `NoRegisteredProviderFound` | with `--remediate`, the harness reads the namespace out of the message, runs `az provider register --namespace <ns> --wait`, and retries once. If the namespace cannot be read it registers **nothing** and says so — guessing one would assert something it never established. |
| `PrincipalNotFound` on a just-created identity | waited out and retried; no operator action |
| `ContainerAppOperationInProgress`, `DeploymentActive`, throttling, Azure 5xx | serialized and retried |

Everything else hands back a named remediation. `quota` carries the portal path;
`permission` carries the `az role assignment create` shape with the role and
scope to fill in.

---

## Where the notice goes

Failure notices open or update **one dedicated, OPEN issue per failing
workflow**, titled `deploy: <workflow> is failing`, via
`.github/scripts/deploy-notify-failure.mjs`. The body renders the classified
failure from `deploy-failure.json`.

This replaced a comment on `issue_number: 279` — *"CSA Loom — v1 build
roadmap"*, **state CLOSED, 289 comments** — with the body "Check workflow logs".
That was the literal mechanism by which 47 days of daily deploy failure stayed
invisible. A hard-coded issue number in a deploy workflow is now a
merge-blocking guard failure (C1).

When no `deploy-failure.json` exists, the notice says **"No classification was
captured for this failure"** and asserts nothing — it does not guess.

---

## Reading a message correctly

The three states are kept apart everywhere, and the wording tells you which one
you are in:

| Wording | What it means |
|---|---|
| "the registry ANSWERED and the tag is absent" | the image genuinely is not there |
| "could NOT read … so the existence … is UNPROVEN (not disproven)" | nothing is known; the gate fails rather than skipping |
| "ARM answered ResourceNotFound" | the resource genuinely does not exist |
| "Could not establish whether … exists" | the probe failed for some other reason; the step refuses to continue |
| "Could not classify this failure … No cause is asserted" | the taxonomy has a gap; attach the run to a new issue |

A step that cannot verify an outcome **fails**. A supply-chain gate that skips an
image it could not read is not a gate, and a roll that quietly omits an app
reports success having deployed a subset.

---

## Adding a signal to the taxonomy

Only add a string you have **observed** Azure emit, and record where in
`observed`. A guessed signal is worse than no signal: an unmatched failure falls
to `unknown` and fails closed with an honest "I could not classify this", which
is a correct outcome. A wrong match is not — `scripts/ci/roll-gate-decision.mjs`
carries the cautionary tale, where a draft matched `the tag does not exist` when
`az` actually emits `the SPECIFIED tag does not exist`.

Add the case to `apps/fiab-console/lib/deploy/__fixtures__/failure-corpus.json`
in the same change. That corpus pins both classifier implementations — the
TypeScript one the console uses and the Node one CI uses — so either drifting
turns its own suite red.

---

## Preflight — check before you spend

These preflights exist and produce concrete remediations:

| Preflight | Where it runs | Checks | Emits |
|---|---|---|---|
| Deploy preflight | Console wizard | `Microsoft.Resources/deployments/write` on the target subscription; registration of the six resource providers | The exact `az role assignment create` and `az provider register` commands |
| Quota preflight | Console wizard | Regional vCPU by VM family against what the deploy needs | The quota-increase portal link with family + region prefilled |
| Private-DNS link preflight | `deploy-fiab-commercial.yml` (full mode) | Whether the hub VNet is already linked to a **different** zone of a namespace the deploy will link (`scripts/csa-loom/preflight-private-dns-links.mjs`) | The owning zone's coordinates + the ordered migration command; fails the run before the deploy would die 20 minutes in |
| Brownfield reconcile discovery | `deploy-fiab-commercial.yml` (both modes, before what-if) | Whether the hub VNet already has a Vpn-type gateway and/or an `azure-api.net` zone link — Azure singletons a create-new PUT can never beat (`scripts/csa-loom/preflight-brownfield-adopt.mjs`) | `existingVpnGatewayName` / `apimGatewayDnsLinkName` template parameters so the deploy ADOPTS the existing names; **fails** the step when the estate cannot be read (a failed read is not an absence) |

The wizard preflights are **not currently invoked from the CI/workflow deploy
paths** — so a workflow-driven deploy can still hit a quota failure that a
preflight would have caught in seconds. Wiring the shared preflight into every
tier is in flight.

To run the equivalent checks by hand before a deploy:

```bash
az role assignment list --assignee <deploy-principal> --scope /subscriptions/<sub-id> -o table
az provider list --query "[?namespace=='Microsoft.App'||namespace=='Microsoft.Databricks'].{ns:namespace,state:registrationState}" -o table
az vm list-usage -l <region> -o table
```

---

## Messages you should not trust

Inaccuracies of this shape are `deploy-integrity.md` R7 violations. The table
below is kept as a live record: the first three rows were **fixed by the failure
engine** and are shown with the wording that replaced them, so you can recognise
the pattern; the last row is **still open**.

| Where | What it used to say | Why that was wrong | State |
|---|---|---|---|
| `full-app-deploy-commercial.yml` — supply-chain verification loop | `<app>:<tag> not found in <acr> … Skipping its verification` | The digest read discarded the registry's answer with `2>/dev/null`, so an unreachable registry (firewall closed, token denied, throttle) and a genuinely absent tag produced the same message — **and the supply-chain gate was silently skipped for that image** | **Fixed.** stderr is captured and classified. Absence is claimed only when the registry answered `ManifestUnknown`/`TagNotFound`; anything else is `UNPROVEN` and **fails** the gate |
| `full-app-deploy-commercial.yml` — roll loop | `container app <app> not found in <rg> — skipping` | An auth failure or throttle on `az containerapp show` read as "not found". The roll could then report success having rolled only a subset | **Fixed.** Absence is claimed only when ARM answered `ResourceNotFound`; otherwise the step errors with `Could not establish whether container app <app> exists` |
| `deploy-fiab-commercial.yml` / `-gcc` / `-gcch` — failure notification | A comment on issue **#279** saying `Check workflow logs` | #279 is a **closed** roadmap issue with 289 comments. Nobody was watching it. This was the literal mechanism by which weeks of deploy failure stayed invisible | **Fixed.** `.github/scripts/deploy-notify-failure.mjs` opens/updates one dedicated OPEN issue per failing workflow. A hard-coded issue number in a deploy workflow is now a merge-blocking guard failure |
| `loom-roll-and-validate.yml` when its upstream build fails | The run records **`skipped`** | A skipped roll caused by an upstream failure is a failure. Nothing goes red at the roll level and the estate simply never advances | **Open** — not addressed by the failure engine |

**The reference shape:** the roll's manifest-digest read uses
`scripts/ci/resolve-acr-digest.sh`, which keeps three states apart — digest
resolved, genuinely absent (`REFUSING TO ROLL — the registry answered NOT FOUND
on every attempt`), and unreadable (`could not READ … This is NOT proof the tag
is missing`).

---

## Is the estate actually running what you merged?

A merge is not a deployment. Before assuming a fix is live:

```bash
# What SHA is the live Console running?
curl -s https://<your-console-host>/build-marker.txt

# How far behind main is it?
git log --oneline <live-sha>..origin/main | wc -l
```

And check every deploy path, not just the one you dispatched:

```bash
for wf in full-app-deploy-commercial deploy-fiab-commercial deploy-fiab-gcch \
          csa-loom-post-deploy-bootstrap build-fiab-images-acr-tasks \
          loom-roll-and-validate; do
  echo "== $wf"
  gh run list --workflow "$wf.yml" --limit 3 \
    --json conclusion,createdAt --jq '.[] | "\(.conclusion // "never-run")\t\(.createdAt)"'
done
```

> **A deploy path that has never run is the loudest case, not a silent pass**
> (`deploy-integrity.md` R3). As of 2026-08-05, `gov-build-images` and
> `deploy-fiab-il5` have never executed.

---

## Status: what is automated today

`deploy-integrity.md` R6 requires every failure to classify itself, retry what is
retryable, and hand back a concrete remediation. Measured against this branch:

**R4 — which cloud this was verified against.** The classifier and the retry
harness are exercised by their own corpus-pinned suites and by the two
Commercial workflows that invoke them; the classifications below are therefore
**verified on Azure Commercial**. **No part of the failure engine has been
exercised on Azure Government** — Gov deploys do not call it at all (#3017). The
ARM codes and class boundaries are boundary-independent and remain usable for
manual triage on Gov; the *automation* is not present there.

| Capability | State |
|---|---|
| The eight-class taxonomy as a shared module both CI and the product use | **Implemented.** `apps/fiab-console/lib/deploy/failure-taxonomy.json` is read by the console (`failure-taxonomy.ts`) and by CI (`scripts/ci/deploy-classify.mjs`); one corpus pins both |
| Bounded, classified retry on `az deployment sub create` | **Implemented, Commercial only** — `deploy-fiab-commercial.yml` runs it under `deploy-retry.mjs --step "az deployment sub create (…)"` |
| Classified retry on the Container Apps roll | **Implemented, Commercial only** — `full-app-deploy-commercial.yml`, `--step "az containerapp update (…)"` |
| Classified retry on `az acr build` | **Implemented, Commercial only** — `full-app-deploy-commercial.yml`, `--step "az acr build (…)"`. A deterministic quota denial is now attempted **once** instead of three times |
| **Any classified retry on a Gov deploy path** | **Not implemented (#3017).** `deploy-fiab-gcch.yml` never invokes `deploy-retry.mjs`; `deploy-fiab-il5.yml` and `gov-build-images.yml` have never run at all. GCC-High's three most recent runs all ended `failure` (2026-08-01/02/03) |
| **The guard that would catch a hand-rolled retry loop, on Gov** | **Not effective (#3017).** `check-deploy-failure-handling.mjs` selects files by filename; 13 `gov-provision-*` workflows that mutate Azure are out of scope |
| Quota preflight before the image build | **Not wired** into the build workflow. The Console wizard runs one; the workflow does not |
| Day-0 adoption fitness before any resource is created | **Not wired (#3014).** `lib/deploy/fitness.ts` exists and is unit-tested; no production caller. An unusable adopted resource still fails mid-deploy |
| Platform self-remediation | **Partial.** `--remediate` registers a missing resource provider and retries once, and reads the namespace out of the message rather than guessing. Role grants, private endpoints and CIDR re-planning are **not** automated. On the **local-CLI** path nothing is auto-registered — `lib/setup/deploy-preflight.ts` only emits the `az provider register` commands |
| Failure notification to a watched target | **Implemented** — one dedicated OPEN issue per failing workflow (`deploy-notify-failure.mjs`), guarded against a regression to a hard-coded number |
| Estate-drift signal on `/admin/readiness` | **Not implemented on this branch** — no live-SHA or commits-behind indicator exists in the Console. Tracked separately (#3000) |

For anything still marked not-implemented, **classify by hand using this page** —
the class boundaries above are the ones the engine uses.

---

## Related

- [**Greenfield deployment**](greenfield.md)
- [**Brownfield deployment**](brownfield.md)
- [**Discovery and adoption**](discovery-and-adoption.md)
- [Runbook — deploy failure](../runbooks/deploy-failure.md) — the short triage card
- [Runbook — first deploy](../runbooks/first-deploy.md)
- `.claude/rules/deploy-integrity.md` — R1–R8
