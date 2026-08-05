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
| `EnterpriseTenantAlreadyExists` | A Purview account already exists in this tenant. Only one is allowed | Adopt it: `EXISTING_PURVIEW=<name>` **and** `-p purviewEnabled=false`. See [Brownfield class B](brownfield.md#class-b--adopting-binds-the-console-but-does-not-suppress-creation) |
| `PrivateDnsZoneAlreadyExists` | The `privatelink.*` zone exists — almost always a re-deploy after a partial failure | Delete the conflicting zone (`az network private-dns zone delete -n <zone> -g <rg>`) or deploy into a clean resource group. **There is no `existingPrivateDnsZones` parameter.** An earlier version of this runbook claimed one; it has never existed |
| `VnetAddressRangeInUse` | The hub CIDR collides, or the hardcoded `10.100.0.0/16` DLZ spoke CIDR does | Set `hubVnetCidr` to a free `/16`. The spoke CIDR is not settable from the root template today — see [Brownfield class C](brownfield.md#class-c--no-adoption-path-exists-today) |
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

## Preflight — check before you spend

Two preflights exist and produce concrete remediations:

| Preflight | Checks | Emits |
|---|---|---|
| Deploy preflight | `Microsoft.Resources/deployments/write` on the target subscription; registration of the six resource providers | The exact `az role assignment create` and `az provider register` commands |
| Quota preflight | Regional vCPU by VM family against what the deploy needs | The quota-increase portal link with family + region prefilled |

They run inside the Console wizard. **They are not currently invoked from the
CI/workflow deploy paths** — so a workflow-driven deploy can still hit a quota
failure that a preflight would have caught in seconds. Wiring the shared
preflight into every tier is in flight.

To run the equivalent checks by hand before a deploy:

```bash
az role assignment list --assignee <deploy-principal> --scope /subscriptions/<sub-id> -o table
az provider list --query "[?namespace=='Microsoft.App'||namespace=='Microsoft.Databricks'].{ns:namespace,state:registrationState}" -o table
az vm list-usage -l <region> -o table
```

---

## Messages you should not trust

These are live inaccuracies in this repo's own workflows, recorded so they do
not send you down the wrong path. Each is a `deploy-integrity.md` R7 violation
with a tracked fix.

| Where | What it says | What it may actually mean |
|---|---|---|
| `full-app-deploy-commercial.yml` — supply-chain verification loop | `<app>:<tag> not found in <acr> … Skipping its verification` | The registry may simply have been **unreachable** (firewall closed, token denied, throttle). The digest read discards the registry's answer with `2>/dev/null`, so an unreadable registry and a genuinely absent tag produce the same message — **and the supply-chain gate is silently skipped for that image** |
| `full-app-deploy-commercial.yml` — roll loop | `container app <app> not found in <rg> — skipping` | An auth failure or throttle on `az containerapp show` reads as "not found". The roll can then report success having rolled only a subset |
| `deploy-fiab-commercial.yml` — failure notification | A comment on issue **#279** saying `Check workflow logs` | #279 is a **closed** roadmap issue with hundreds of comments. Nobody is watching it. This is the mechanism by which weeks of deploy failure stayed invisible. Do not rely on being notified — check the workflow list |
| `loom-roll-and-validate.yml` when its upstream build fails | The run records **`skipped`** | A skipped roll caused by an upstream failure is a failure. Nothing goes red at the roll level and the estate simply never advances |

**Already fixed, for contrast:** the roll's manifest-digest read now uses
`scripts/ci/resolve-acr-digest.sh`, which keeps three states apart — digest
resolved, genuinely absent (`REFUSING TO ROLL — the registry answered NOT FOUND
on every attempt`), and unreadable (`could not READ … This is NOT proof the tag
is missing`). That is the shape every message in the table above needs.

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
retryable, and hand back a concrete remediation. Measured against `main` on
**2026-08-05**:

| Capability | State |
|---|---|
| The eight-class taxonomy as a shared module both CI and the product use | **Not implemented.** This page is the taxonomy; nothing consumes it programmatically yet |
| Bounded, classified retry on `az deployment sub create` | **Not implemented.** The core provision runs bare — no retry, no post-failure triage |
| Classified retry on the Container Apps roll | **Implemented** — retries only on `OperationInProgress`, prints stderr, returns non-zero on anything else. This is the reference shape |
| Classified retry on `az acr build` | **Not implemented.** It retries 3 times with no classification, so a deterministic quota denial burns the budget and reports "failed after 3 attempts" |
| Quota preflight before the image build | **Not wired** into the build workflow |
| Platform self-remediation (register the RP, grant the role, create the private endpoint, re-plan the CIDR) | **Not implemented** |
| Failure notification to a watched target | **Not implemented** — see the table above |
| Estate-drift signal on `/admin/readiness` | **Not implemented** — no live-SHA or commits-behind indicator exists in the Console |

Work on the classification engine, the retry harness, and the estate-drift
signal is in flight. Until it lands, **classify by hand using this page** — the
class boundaries above are the same ones the engine will use.

---

## Related

- [**Greenfield deployment**](greenfield.md)
- [**Brownfield deployment**](brownfield.md)
- [**Discovery and adoption**](discovery-and-adoption.md)
- [Runbook — deploy failure](../runbooks/deploy-failure.md) — the short triage card
- [Runbook — first deploy](../runbooks/first-deploy.md)
