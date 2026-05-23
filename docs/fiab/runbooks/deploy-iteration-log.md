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

## Outstanding (post-#302 merge)

After the Cosmos parent: fix lands, the next iteration is expected to surface
issues in:
- Databricks workspace creation (custom VNet validation, managed RG conflicts)
- Synapse workspace (managed VNet provisioning latency, default storage account naming)
- Event Grid system topic on a private-endpoint-only storage account
- Any remaining state from prior partial deploys (the teardown script polls
  for completion which can take 15-30 min for Cosmos accounts)

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
