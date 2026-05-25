# CSA Loom v3 — Security Hardening

**Status:** In progress (started 2026-05-25)
**Branch:** `access-patterns-vpn-agw-fd`
**Subscription:** `363ef5d1-0e77-4594-a530-f51af23dbf8c` (FedCiv ATU FFL — DLZ)
**Console UAMI principalId:** `e61f3eb3-c646-4183-8198-4c4a34cd9a01`

This document records the v3 security posture for the CSA Loom platform. Each
phase is independently committed.

---

## Phase 1 — Microsoft Defender for Cloud coverage

Enabled `Standard` tier for the three plans that were still `Free`. Everything
else was already on Standard from earlier waves.

### Final coverage (post-change)

| Plan | Tier | Notes |
|---|---|---|
| VirtualMachines | Standard | already |
| SqlServers | Standard | already |
| AppServices | Standard | already |
| StorageAccounts | Standard | already |
| SqlServerVirtualMachines | Standard | already |
| KubernetesService | **Standard** | enabled in v3 |
| ContainerRegistry | **Standard** | enabled in v3 |
| KeyVaults | Standard | already |
| Dns | Free | not in scope for Loom |
| Arm | Standard | already |
| OpenSourceRelationalDatabases | Standard | already |
| CosmosDbs | Standard | already |
| Containers | Standard | unified plan, already |
| CloudPosture | Standard | already |
| Api | Standard | already |
| AI | **Standard** | enabled in v3 |
| Discovery | Standard | already |
| FoundationalCspm | Standard | already |

### Commands used

```bash
az security pricing create -n KubernetesService --tier Standard
az security pricing create -n ContainerRegistry --tier Standard
az security pricing create -n AI            --tier Standard
```

Raw output is captured in `temp/v3-security/defender-pricing-after.tsv`.

---

## Phase 2 — ACR Defender + container image scanning

### Registry: `acrloomm56yejezt7bjo` (rg-csa-loom-admin-eastus2)

- SKU: Premium
- Public network: Disabled (PE-only)
- Admin user: disabled (UAMI / AAD AcrPull/AcrPush only)
- Zone redundancy: Enabled

### Defender for Containers extensions (subscription-level)

All five extensions now enabled on the `Containers` plan:

| Extension | State | Purpose |
|---|---|---|
| ContainerRegistriesVulnerabilityAssessments | Enabled | Trivy-based image vuln scans (on push + weekly) |
| AgentlessDiscoveryForKubernetes | Enabled | API-server posture |
| AgentlessVmScanning | Enabled | Node-VM scanning |
| ContainerSensor | Enabled | Runtime detection (CA env via DaemonSet) |
| ContainerIntegrityContribution | **Newly enabled in v3** | Image signing / supply chain integrity signals |

```bash
az security pricing create -n Containers --tier Standard \
  --extensions name=ContainerIntegrityContribution isEnabled=True
```

Image scanning is automatic for all images pushed to `acrloomm56yejezt7bjo`;
findings flow into Defender for Cloud > Recommendations.

---

## Phase 3 — Key Vault references for Console secrets

### Before

The Loom Console Container App (`loom-console` in `rg-csa-loom-admin-eastus2`)
stored two highly sensitive secrets **as raw values** inside the Container App
secret store:

- `loom-msal-client-secret` — Entra app client secret (used for MSAL OBO)
- `session-secret` — AES-256-GCM key for session cookie HKDF

Raw values are recoverable by anyone with `Microsoft.App/containerApps/listSecrets/action`
on the resource, which is broad and not auditable through KV access policies.

### After

Both secrets now live in `kv-loom-m56yejezt7bjo` (RBAC-mode, private-endpoint-only)
and are referenced via Container App **Key Vault references**, fetched at
runtime by the Console UAMI (`uami-loom-console-eastus2`).

| CA secret name | KV secret name | Identity used to fetch |
|---|---|---|
| `loom-msal-client-secret` | `loom-msal-client-secret` | uami-loom-console-eastus2 |
| `session-secret` | `loom-session-secret` | uami-loom-console-eastus2 |

### RBAC change

Console UAMI (`principalId e61f3eb3-c646-4183-8198-4c4a34cd9a01`) now has
**Key Vault Secrets User** at vault scope:

```bash
# az CLI's role assignment create has a "MissingSubscription" bug on this tenant
# when looking up roles by name. We invoke ARM directly:
az rest --method PUT \
  --url "https://management.azure.com/subscriptions/363ef5d1-.../resourceGroups/rg-csa-loom-admin-eastus2/providers/Microsoft.KeyVault/vaults/kv-loom-m56yejezt7bjo/providers/Microsoft.Authorization/roleAssignments/$(uuidgen)?api-version=2022-04-01" \
  --body '{"properties":{
    "roleDefinitionId":"/subscriptions/.../providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6",
    "principalId":"e61f3eb3-c646-4183-8198-4c4a34cd9a01",
    "principalType":"ServicePrincipal"}}'
```

### CA secret references

```bash
UAMI_ID="/subscriptions/.../uami-loom-console-eastus2"
az containerapp secret set -n loom-console -g rg-csa-loom-admin-eastus2 \
  --secrets \
  "loom-msal-client-secret=keyvaultref:https://kv-loom-m56yejezt7bjo.vault.azure.net/secrets/loom-msal-client-secret,identityref:$UAMI_ID" \
  "session-secret=keyvaultref:https://kv-loom-m56yejezt7bjo.vault.azure.net/secrets/loom-session-secret,identityref:$UAMI_ID"
```

### Verification

After forcing a new revision (revision-restart alone was insufficient for the
secret resolver to re-bind on already-running replicas), the BFF smoke test
passes:

```
200  /api/me           {"authenticated":true,"user":{...}}
200  /api/health       {"status":"ok"}
200  /api/workspaces   [...]
```

Cookie was minted locally via `temp/uat-pw/mint-session.mjs` using the
KV-stored session secret, and the running app decrypted/validated it
successfully — proving the secret resolution chain (CA secret → KV ref → KV
secret value via UAMI) works end-to-end.

### Notes & gotcha discovered

- `az keyvault secret set --file <path>` preserves trailing CRLF / LF in the
  file. **Strip newlines** before upload (`printf "%s" "$(cat …)" | tr -d '\r\n'`),
  otherwise the cookie HKDF input mismatches by one byte and all session
  validation silently fails (route returns 200 with `authenticated: false`).
- Container App secret values resolved from KV are only re-read on **new
  revision creation**, not on `revision restart`. The `update --set-env-vars`
  with a throwaway tick variable forces a new revision.
- KV public-network-access had to be temporarily set to `Enabled` + an IP rule
  for our own workstation IP added to write the secrets, then both reverted.
  Final state: `publicNetworkAccess=Disabled`, no IP rules.

### Deferred

The other CA secrets (`azure-client-secret`, `deploy-sp-secret`, `deploy-sp-id`)
were not migrated in this phase. They are not on the user-facing critical path
(used by deployment automation only). Recommend migrating in v3.x once a
deployment-script-based KV write path is in place to avoid the temporary
public-network toggle workaround.

---
