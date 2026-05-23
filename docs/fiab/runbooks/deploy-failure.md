# Runbook — Deploy failure

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

| Symptom | Likely cause | Fix |
|---|---|---|
| `Quota exceeded` for Databricks Premium | Region quota | Request quota via Azure portal → Subscriptions → Usage + quotas; or pick different region |
| `RoleAssignmentExists` | Pre-existing assignment | Run `az role assignment delete` for the conflict then re-run |
| `InvalidTemplateDeployment` on Container Apps in IL4 | Container Apps not at IL4 | Set `containerPlatform = 'aks'` in `.bicepparam` |
| `Forbidden` on Key Vault Premium HSM | Lacks `Microsoft.KeyVault/managedHsms/write` | Request elevated role |
| `VnetAddressRangeInUse` | CIDR conflict | Pick a different CIDR; update `hubVnetCidr` param |
| `PrivateDnsZoneAlreadyExists` | Re-deploy after previous failure | `az network private-dns zone delete` for conflicts; or set `existingPrivateDnsZones = true` |
| `ManagedIdentityRoleAssignmentDelay` | Eventual-consistency on RBAC | Wait 5 min; re-run |

## Remediation

1. **Triage** — note the failed module + Azure error code
2. **Apply fix** — per table above
3. **Resume** — `azd provision` (idempotent; picks up from failure
   point)
4. **Verify** — `curl <console-url>/api/health` returns 200

## Prevention

- Run `azd provision --preview` (or `bicep what-if`) before
  every deploy
- Pre-check quotas: `az vm list-usage -l <region>`
- Validate role assignments before deploy
- Keep `.bicepparam` files under Git review

## Escalation

If the error doesn't match the table above:
- Open GitHub issue with label `csa-loom` + `csa-bug` + paste the
  deployment operation error JSON
- Internal Microsoft: `#csa-loom-build` Teams channel
