# Deploy iteration log — first real provision

Honest record of every iteration through the first real `run_mode=full`
deploy of the CSA Loom Bicep stack against Azure Commercial. Each
iteration surfaced new real-Azure failures specific to tenant /
region / API version that couldn't be caught by Bicep lint or what-if
alone. This document is the proof of what was hit + what was fixed —
and what remains as known intermittent issues.

## Cumulative result (as of 2026-05-23)

- ✅ **Auth validated** end-to-end against Azure Commercial (Wave 2 SP auth fix)
- ✅ **Bicep what-if validates** the entire 30+ resource stack against the live tenant
- ✅ **5 iterations of real provision** fixing real Azure regional / state / API issues
- ⏳ **Full provision** still has remaining issues — see "Outstanding" below

## Iteration log

| # | Run ID | Failure | Fix | PR |
|---|---|---|---|---|
| 1 | 26322792356 | Tenant already has Enterprise Purview account; only 1 per tenant | Default `purviewEnabled = false`; operator opts in | #294 |
| 2 | 26324494445 | (a) KV role assignment: empty admin group; (b) AI Search: regional capacity in eastus2; (c) Container Apps Env: missing LAW sharedKey | (a) Gate role on `!empty(adminEntraGroupId)`; (b) `aiSearchEnabled = false`; (c) wire `lawSharedKey` from monitoring | #297 |
| 3 | 26325085349 | (a) DLZ network CIDR malformed ('10.mw.0.0/16' from uniqueString); (b) DLZ ADX DB referenced non-existent admin cluster | (a) Deterministic `10.100.0.0/16` default; (b) `adxEnabled = false` gate | #299 |
| 4 | 26325723745 | synapse.bicep called shared diag-settings helper without scope override → BadRequest at RG scope | Removed broken module call; inline diag resource was already correct | #300 |
| 5 | 26326256884 | (a) Event Hubs CG referenced `$default` event hub that didn't exist; (b) Storage versioning incompatible with HNS; (c) Cosmos zonal account capacity in eastus2 | (a) Removed manual CG; (b) `isVersioningEnabled = false`; (c) `zoneRedundant` param default false | #301 |
| 6 | 26327020669 | Cosmos containers used slash-path nested name pattern → what-if BadRequest | Refactored to `parent: dbs[i]` array-index reference | #302 |

## Continued iteration after #302

| # | Run ID | Failure | Fix | PR |
|---|---|---|---|---|
| 7 | 26328703349 | Synapse — 3 issues: AAD admin needs SID; firewall rules need public access; deployment-script needs valid UAMI | Gate AAD admin on `!empty()`; gate firewall on `managedVnet=false`; new `synapseRoleAssignmentUamiId` param | #304 |
| 8 | 26329796598 | Databricks: NSG `ConflictWithNetworkIntentPolicy` — vnet-injected ADB needs specific worker outbound rules | Added 4 required NSG security rules (worker→Sql, worker→Storage, worker→EventHub, intra-vnet inbound) | #305 |

## 🎉 Iter #8 SUCCESS

**Run [26330578932](https://github.com/fgarofalo56/csa-inabox/actions/runs/26330578932)** — first full successful deploy against Azure Commercial.

- Bicep what-if: ✅
- Provision: ✅ in 10m21s
- Post-provision validation (from inside cluster): ✅
- External smoke test (best-effort): ✅
- Resources kept per `keep_resources=true`

**Console URL emitted**: `https://loom-console.delightfulmoss-96202bfd.eastus2.azurecontainerapps.io`
(VNet-internal — requires Bastion to browse)

**Resources successfully provisioned** in `rg-csa-loom-admin-eastus2` + `rg-csa-loom-dlz-single-eastus2`:

- Hub VNet + 7 subnets + Bastion Standard + Azure Firewall + 17 private DNS zones
- 7 UAMIs
- Key Vault Premium + private endpoint
- LAW + AppInsights + Sentinel + 2 AI threat-detection rules
- ACR Premium + private endpoint
- Container Apps Env (internal, zone-redundant)
- Catalog stub + AI defense playbook
- DLZ: spoke VNet + ADB-compliant NSG + peering
- DLZ storage (ADLS Gen2 + HNS + 5 containers + EG topic + PEs)
- DLZ Databricks workspace (Premium, VNet-injected)
- DLZ Synapse workspace (Serverless SQL + managed VNet + audit)
- DLZ Event Hubs (Kafka surface + PE)
- DLZ Cosmos DB (5 workload databases + PE)

**Gated off per first-deploy convention** (operator opts in module-by-module):

- AI Foundry Hub (`aiFoundryEnabled`)
- APIM (`apimEnabled`)
- AI Search (`aiSearchEnabled` — regional capacity)
- ADX DB (`adxEnabled` — needs cluster pre-provisioned)
- App deployments (`deployAppsEnabled` — needs container images in ACR)
- Synapse data-plane RBAC script (`synapseRoleAssignmentUamiId`)
- Purview (`purviewEnabled` — tenant collision per iter #1)

## Iter #9 — image build (separate iteration cycle)

**Run [26330782170](https://github.com/fgarofalo56/csa-inabox/actions/runs/26330782170)** — image build via GitHub runners.

All 6 builds failed with `CONNECTIVITY_REFRESH_TOKEN_ERROR` at ACR login.

**Root cause**: ACR has `publicNetworkAccess: Disabled` (correct per security posture) — unreachable from external GitHub runners.

**Fix paths** (operator chooses):

- **A — ACR Tasks** (recommended): build inside Azure, reaches ACR via internal network. Per-app: `az acr build --registry $ACR --image loom-console:v0.1 ./apps/fiab-console`. Wrap in `build-fiab-images-acr-tasks.yml`.
- **B — Self-hosted GitHub runner inside Hub VNet**: VM- or AKS-based runner with VNet access; tag workflow to use it.
- **C — Temporarily enable ACR public access**: less secure but fastest first-time unblocker.

## Outstanding follow-ups

1. **Image build via ACR Tasks** — add `.github/workflows/build-fiab-images-acr-tasks.yml`
2. **Re-dispatch with `deployAppsEnabled=true`** once images exist
3. **Front-end UI validation**: requires Bastion + jumpbox in hub VNet; per [first-deploy.md](first-deploy.md) Phase 4
4. **GCC + GCC-High validation**: per [secrets-bootstrap.md](secrets-bootstrap.md), needs SP credentials in those tenants
5. **Build 2026 freshness rescan**: auto-fires Jun 8

## Recommended next-step pattern

1. **Always teardown first** between deploy attempts when state is suspect:
   ```bash
   gh workflow run teardown-fiab-commercial -f confirm=DELETE
   ```
2. **Wait for teardown completion** (up to 30 min for Cosmos cleanup) before re-dispatching.
3. **Dispatch with keep_resources=true** during iteration so you can inspect
   live state:
   ```bash
   gh workflow run deploy-fiab-commercial -f run_mode=full -f keep_resources=true
   ```
4. **Use the post-provision validation script** which curls from inside the
   cluster (works around VNet-internal ingress).

## Region recommendations

Based on iter #2 + #5 capacity failures in **eastus2**:
- AI Search: try `eastus`, `centralus`, or `westus3`
- Cosmos zonal: stick with default `zoneRedundant=false` in eastus2; try `eastus` for zonal
- All other resources have validated successfully in eastus2

## Cost notes

- Each `run_mode=full` attempt that gets past provision spins up resources
  costing roughly **$10-30/hour** at F8 capacity SKU + 1 Databricks workspace.
- The `keep_resources=true` workflow input WARNS about ongoing spend in the
  log; operator manually runs the teardown workflow when done iterating.
- Failed deploys roll back via ARM (most resources auto-delete on failure),
  but Cosmos accounts in particular leave partial state.

## Related

- [Loom LAW monitoring + alert pack](loom-law-monitoring.md)
- [Deploy failure runbook](deploy-failure.md)
- [First deploy operator playbook](first-deploy.md)
- Workflow: `.github/workflows/deploy-fiab-commercial.yml`
- Teardown workflow: `.github/workflows/teardown-fiab-commercial.yml`
- Script: `.github/scripts/fiab-teardown.sh` (multi-sub aware; KV purge before RG delete)
