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
