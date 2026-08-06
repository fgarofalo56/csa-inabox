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

```bash
# List recent sub-scoped deployments
az deployment sub list \
  --query "[?starts_with(name, 'csa-loom')] | [?properties.provisioningState != 'Succeeded'] | [].{name:name,state:properties.provisioningState,error:properties.error.message}" \
  -o table

# Drill into specific failed deployment
az deployment sub show --name <deployment-name> --query "properties.error"

# Find inner-module errors
az deployment operation sub list --name <deployment-name> --query "[?properties.statusCode != '200']" -o table
```

Common failure modes:

| Symptom | Class | Likely cause | Fix |
|---|---|---|---|
| `Quota exceeded` for Databricks Premium | quota | Region quota | Request quota via Azure portal → Subscriptions → Usage + quotas; or pick a different region. **Do not retry — it is deterministic** |
| `QuotaExceeded: standardDDSv5Family Cores` during an image build | quota | The ACR-task agent pool has no cores | Raise the VM-family quota for that region, or build without the dedicated pool |
| `RoleAssignmentExists` | config | Pre-existing assignment | Re-run with `skip_role_grants=true`, or `az role assignment delete` the conflict |
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
   the workflow needs `allow_existing_hub=true` **and** `keep_resources=true`
5. **Verify** — `curl <console-url>/api/health` returns 200, then open the
   Console and confirm sign-in and `/admin/readiness`

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
- Open GitHub issue with label `csa-loom` + `csa-bug` + paste the
  deployment operation error JSON
- An unclassifiable failure is also a gap in the taxonomy — say so in the issue
  so the class gets added
- Internal Microsoft: `#csa-loom-build` Teams channel
