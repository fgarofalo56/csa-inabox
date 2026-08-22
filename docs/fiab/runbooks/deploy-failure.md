# Runbook — Deploy failure

> **This is the short triage card.** The full failure taxonomy — eight classes,
> the ARM codes that map to each, what retries, what the platform can fix
> itself, and which of this repo's own error messages are currently untrue — is
> [**Failure recovery**](../deployment/failure-recovery.md). Start here for a
> known symptom; go there for anything not in the table below.

> **On Azure Government, none of this is automated (#3017).** The classifier and
> the bounded-retry harness are wired into the two Commercial deploy workflows
> only; `deploy-fiab-gcch.yml` does not invoke `scripts/ci/deploy-retry.mjs`, and
> `deploy-fiab-il5.yml` has never run. The class column below is still the right
> way to triage a Gov failure — you just do it by hand, and no
> `deploy-failure.json` is produced.

## Symptom

`azd up` or Loom Setup Wizard deploy fails with a non-`Succeeded`
ARM deployment state. Console URL doesn't return 200.

## Diagnosis

**Start here.** The top-level ARM error on a failed subscription deploy is
content-free — it is always `DeploymentFailed: At least one resource deployment
operation failed` — and `az deployment sub create` writes ~200 lines of bicep
linter warnings to stderr, so the real cause is in neither place. It sits two or
more levels down, inside the failed deployment *operations*. Drill to it:

```bash
node scripts/ci/deploy-arm-errors.mjs --name <deployment-name> --scope sub [--subscription <sub>]
```

It walks the failed operations recursively (following nested
`Microsoft.Resources/deployments` targets) and prints every leaf `code: message`
with the resource it belongs to. It has three outcomes and only one is a pass:
`found`, `none` (ARM answered and nothing failed), and `unreadable` (ARM did not
answer — nothing is asserted). No workflow invokes this script directly; six
deploy workflows reach the same walk through `scripts/ci/deploy-retry.mjs
--arm-deployment`, which runs it on failure and feeds the leaves to the
classifier, so a live run's annotation names the cause instead of reporting
"could not classify" (#3039).

!!! warning "`--json` output is UNREDACTED — do not paste it into an issue (#3829)"
    The default (human-readable) render above is redacted: subscription and
    tenant ids collapse to `<redacted>` and any GUID — including the object id in
    a `flexibleServers/administrators` leaf name, `<server>/<objectId>` — becomes
    `<guid>`. Paste it freely.

    `--json` is deliberately **raw**. It exists so the operator keeps the full
    ARM ids that some remediations in the table below actually need (the
    `RoleAssignmentExists` row's `az role assignment delete --ids <id>` is the
    one that matters). That means its output carries subscription ids, tenant
    ids, full resource ids and Entra object ids. **This repo is public** — treat
    `--json` output as local-only. If you need to attach evidence to a public
    issue, attach the default render, or the `deploy-failure.json` artifact,
    which is redacted at its own boundary.

!!! danger "What the lane redacts for you, and the ONE thing it does not (#3829)"
    Everything the deploy lane **composes** is redacted at the boundary it leaves
    through, and there is exactly one boundary per surface:

    | surface | boundary |
    |---|---|
    | the auto-filed notice issue's **title** and **body** | `deploy-notify-failure.mjs` — `notifyFailure()` |
    | that script's stdout / stderr | `formatStdout()` / `formatStderr()` |
    | `::error::` / `::warning::` / `::notice::` annotations | `deploy-retry.mjs` — `formatAnnotation()` |
    | `deploy-retry.mjs`'s own run-log lines | `formatStderr()` |
    | the `deploy-failure.json` artifact | one `redact()` over the whole serialization |
    | `deploy-arm-errors.mjs`'s default render, and its usage errors | `renderLeaves()`, `formatStdout()` / `formatStderr()` |

    So a workflow or resource name can read back as `deploy-fiab-<guid>` or
    `uami-loom-directlake<guid>`. That is the redactor substituting in place, not
    a corrupted name.

    **The exception, stated plainly: the deployed command's OWN output is NOT
    redacted.** `deploy-retry.mjs` streams the child's stdout live and echoes its
    stderr back verbatim — that is deliberate, because rewriting a command's own
    output would make the wrapper's log disagree with the command's and send an
    investigation somewhere the evidence does not support (R7). **If `az` itself
    prints a subscription, tenant or object id, that id is in the public run log**
    — with or without this harness, exactly as it would be under a bare
    `az deployment sub create`. Treat a failed deploy's raw run log the same way
    you treat `--json`: read it, do not paste it.

    Two narrower residuals in the redactor itself, disclosed rather than implied
    away (`scripts/ci/_azure-redact.mjs` carries the measurements): an **undashed
    32-hex** run is left alone on purpose, because ARM prints the blocking
    role-assignment id that way and the #3439 auto-converger reads it back; and a
    GUID **immediately followed by a hex character** (`<guid>abc`) is not matched.

By hand, the same walk is:

```bash
# List recent sub-scoped deployments
az deployment sub list \
  --query "[?starts_with(name, 'csa-loom')] | [?properties.provisioningState != 'Succeeded'] | [].{name:name,state:properties.provisioningState,error:properties.error.message}" \
  -o table

# The top-level error — expect it to say nothing useful
az deployment sub show --name <deployment-name> --query "properties.error"

# The operations. Repeat at group scope for every nested deployment that failed:
az deployment operation sub   list --name <deployment-name> -o json
az deployment operation group list -g <rg> --name <nested-deployment-name> -o json
```


Common failure modes:

| Symptom | Class | Likely cause | Fix |
|---|---|---|---|
| `Quota exceeded` for Databricks Premium | quota | Region quota | Request quota via Azure portal → Subscriptions → Usage + quotas; or pick a different region. **Do not retry — it is deterministic** |
| `QuotaExceeded: standardDDSv5Family Cores` during an image build | quota | The ACR-task agent pool has no cores | Raise the VM-family quota for that region, or build without the dedicated pool |
| `RoleAssignmentExists` | config | The grant is **already in place** under a different assignment NAME. ARM enforces uniqueness on the `(scope, principalId, roleDefinitionId)` triple, not on the name, so a name-seed change (e.g. the Website Contributor role id correction …706ee → …84772) or a grant created out-of-band by `az role assignment create` (random GUID) blocks the template's create forever | Converge the name: `az role assignment delete --ids <the id printed in the error message>`, then re-run — the template recreates it under its deterministic name. `skip_role_grants=true` suppresses the symptom and leaves the estate un-reconciled; it is a workaround, not a fix |
| `BadRequest: A virtual network cannot be linked to multiple zones with overlapping namespaces` | config | The hub VNet is already linked to a **different** Private DNS zone of the same namespace — usually a leftover zone from a superseded design in another resource group or subscription. Azure permits one link per namespace per VNet, so the admin plane's own link can never be created | **Do not delete the existing link first** — the A records live in that zone and unlinking takes the service dark. Run `node scripts/csa-loom/migrate-private-dns-zone-owner.mjs …` (dry-run by default; `--apply` to execute). It dual-registers under a **new** zone-group config name, moves the links, removes **only** the config that still points at the stale zone, refuses any removal that would empty the group, and re-verifies the group and the record before deleting the stale zone — see [Private DNS zone-owner migration](#private-dns-zone-owner-migration-3039--3046). `node scripts/csa-loom/preflight-private-dns-links.mjs` detects it before the deploy, and `deploy-fiab-commercial.yml` runs that preflight automatically |
| `InvalidTemplateDeployment` on Container Apps in IL4 | config | Container Apps not at IL4 | Set `containerPlatform = 'aks'` in `.bicepparam` |
| `Forbidden` on Key Vault Premium HSM | permission | Lacks `Microsoft.KeyVault/managedHsms/write` | Request elevated role |
| `VnetAddressRangeInUse` | config | CIDR conflict | Pick a different CIDR; update `hubVnetCidr`. The DLZ spoke CIDR (`10.100.0.0/16`) is not settable from the root template today |
| `PrivateDnsZoneAlreadyExists` | config | Re-deploy after a previous failure | `az network private-dns zone delete` the conflicts, or deploy into a clean resource group. **There is no `existingPrivateDnsZones` parameter** — an earlier version of this table said there was; it has never existed in `main.bicep` |
| `EnterpriseTenantAlreadyExists` | config | A Purview account already exists in the tenant — only one is allowed | Adopt it: `EXISTING_PURVIEW=<name>` (+ `_RG`, `_SUB`). No enable-flag override is needed — `provisionPurview` is already false for an `adopt` decision. See [Brownfield](../deployment/brownfield.md) |
| `ManagedIdentityRoleAssignmentDelay` / `PrincipalNotFound` | eventual-consistency | RBAC replication lag | Wait 5 min; re-run |
| `MANIFEST_UNKNOWN` / image pull failure on a Container App | config | Phase 1 ran with `deployAppsEnabled=true` against an **empty** ACR | Re-run phase 1 with `false`, then the image phase. See [Greenfield](../deployment/greenfield.md) |
| `ResourceGroupNotFound` early in `full-app-deploy-commercial` | config | The workflow's `region` input does not match the estate's region | Pass `-f region=<your-region>` |
| `ResourceGroupNotFound` on a multi-sub DLZ | config | A sub-scoped deploy cannot create an RG in a remote subscription | `bash scripts/csa-loom/bootstrap-dlz-rgs.sh` first |
| `ContainerAppOperationInProgress` | transient | A previous roll is still settling | Wait and retry; serialize rolls, never cancel an in-flight roll of the same SHA |

## Remediation

1. **Triage** — note the failed module + Azure error code
2. **Classify** — match the code to a class in
   [Failure recovery](../deployment/failure-recovery.md). Retrying a `quota` or
   `config` failure cannot help
3. **Apply fix** — per table above
4. **Resume** — re-run the same `az deployment sub create` with the fix added.
   The deployment is incremental and idempotent, so it resumes rather than
   restarts. Two exceptions: a partially-created Private DNS zone or a taken
   global name must be removed first, and reconciling an existing hub through
   the workflow needs `allow_existing_hub=true` **and** a `region` that matches
   the estate (a mismatched region is refused — #3029). `keep_resources`
   defaults to `true`; a teardown also needs
   `confirm_teardown_rg=rg-csa-loom-admin-<region>` (#3028)
5. **Verify** — `curl <console-url>/api/health` returns 200, then open the
   Console and confirm sign-in and `/admin/readiness`

### Private DNS zone-owner migration (#3039 / #3046)

`scripts/csa-loom/migrate-private-dns-zone-owner.mjs` adopts a `privatelink.*`
namespace onto the zone that should own it, without taking the service dark.
It is **dry-run by default**; `--apply` executes.

```bash
node scripts/csa-loom/migrate-private-dns-zone-owner.mjs \
  --namespace privatelink.azuredatabricks.net \
  --keep-zone-rg  rg-csa-loom-admin-<region>       --keep-zone-subscription  <sub> \
  --stale-zone-rg rg-csa-loom-dlz-default-<region> --stale-zone-subscription <sub> \
  [--pe-resource-group <rg> …]      # extra scopes to search for private endpoints
```

The plan is 10 steps; the two **terminal** verifications and the removal guard
are the part to understand, because their absence caused a live outage.

| # | step | what it does |
|---|---|---|
| 1 | `ensure-keep-zone` | creates the surviving zone if it is missing |
| 2 | `dual-register` | **adds** a config pointing at the keep zone, under a name nothing else in the group owns (`<ns>-loom-keep`). The record is then in **both** zones |
| 3 | `verify-record-in-keep-zone` | hard gate — refuses to unlink anything until the record is provably in the keep zone |
| 4–5 | `unlink-stale` → `link-keep` | moves each VNet link. **A resolution gap of seconds**: Azure permits one link per namespace per VNet |
| 6 | `verify-links-on-keep-zone` | hard gate — every VNet the stale zone served resolves on the keep zone |
| 7 | `single-register` | removes **only** the config that still points at the stale zone, selected by the name read from the estate |
| 8 | `verify-zone-group-bound-to-keep` | terminal gate — the group still carries a config on the keep zone |
| 9 | `verify-record-after-single-register` | terminal gate — the A records are still in the keep zone |
| 10 | `delete-stale-zone` | the stale zone goes last |

!!! danger "Why steps 2, 7, 8 and 9 look the way they do (#3046)"
    `az network private-endpoint dns-zone-group add|remove --zone-name` selects
    the config **by its `name`**, never by the zone id (measured from the az CLI
    source: `_add.py` / `_remove.py`, `SubresourceSelector`). `add` **replaces**
    a config whose name matches and only appends when it does not.

    The first cut of this script passed `<namespace with dots→dashes>` for both.
    That string is byte-identical to the config name the bicep creates
    (`landing-zone/databricks.bicep:135`), so step 2 *replaced* the stale config
    instead of appending — dual-registration never happened — and step 7 then
    removed the only remaining config, leaving the group **empty**, which
    deregisters the endpoint's A record from every zone. The service went dark
    and the script exited 0, because nothing ran after step 7.

    Now: step 2 uses a name nothing owns and refuses if that name is taken;
    step 7 refuses to remove a config that no longer points at the stale zone,
    that it cannot re-read, or whose removal would leave the group empty or with
    no config on the keep zone; steps 8 and 9 re-check the outcome before
    anything is deleted. Every destructive step re-reads its subject immediately
    before acting, so a re-run **converges** rather than re-applying.

**What the verifications do NOT prove.** They read ARM — the record set exists,
the links exist, the group is bound. They do **not** prove the name resolves from
inside the hub VNet; a hosted runner is not in the VNet. For that, run a lookup
from the in-VNet runner (`loom-aca-runner-smoke.yml`) or over the admin P2S VPN.

**Empty-zone shadowing.** Step 1 creates the keep zone but does not link it, and
step 5 links it only after step 3 has proved the record is there — so the
migration never leaves an empty zone linked to a VNet. That matters: a linked but
empty `privatelink.*` zone **shadows** public resolution for the whole namespace
and returns NXDOMAIN rather than falling through (the Gov Purview incident). If
you stop the migration part-way, an unlinked empty keep zone is harmless; a
linked empty one is not.

## Prevention

- Run `bicep what-if` (`az deployment sub create … --what-if`) before
  every deploy
- Pre-check quotas: `az vm list-usage -l <region>`
- Pre-check the deploy identity's roles and the six resource-provider
  registrations — see
  [Failure recovery → preflight](../deployment/failure-recovery.md#preflight-check-before-you-spend)
- On a brownfield estate, validate adoption candidates (HNS, SKU, deployments,
  metastore assignment) **before** the deploy — see
  [Brownfield → what is validated](../deployment/brownfield.md#step-4-what-is-validated-per-service)
- Keep `.bicepparam` files under Git review

## Escalation

If the error doesn't match the table above:
- Open GitHub issue with label `csa-loom` + `csa-bug`. Attach the **redacted**
  evidence: the default (non-`--json`) `deploy-arm-errors.mjs` render, or the
  `deploy-failure.json` artifact. **Do not paste raw `az deployment operation
  … -o json` or `--json` output, and do not paste the run log's "full captured
  stderr" block** — this repo is public, that output is the command's own and is
  therefore unredacted, and it carries subscription, tenant and Entra object
  ids (#3829)
- An unclassifiable failure is also a gap in the taxonomy — say so in the issue
  so the class gets added
- Internal Microsoft: `#csa-loom-build` Teams channel
