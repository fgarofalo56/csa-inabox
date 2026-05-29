# Disaster recovery

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


CSA Loom DR strategy is **redeploy-from-Git** for compute +
**multi-region storage** for data. Per-component RPO / RTO targets:

## RPO / RTO per component

| Component | RPO | RTO | Mechanism |
|---|---|---|---|
| ADLS Gen2 | 15 min | 0 (RA-GRS = immediately readable in secondary) | GRS / RA-GRS within boundary region pair |
| Loom Console + parity services | Git-state | 30 min | Container images in ACR; redeploy via Bicep |
| Databricks workspace | Git-state (notebooks) | 1-2 h | Re-deploy workspace via Bicep + attach to Git |
| Synapse Serverless | Stateless | 30 min | Re-deploy workspace; external tables re-create |
| ADX cluster | 15 min (continuous export to ADLS) | 1-2 h | Re-deploy cluster + ingest from continuous export |
| Power BI semantic models | Git-state (TMDL) | 1-2 h | Re-deploy via Power BI REST |
| Activator rules | Git-state | 30 min | JSON in Git → Activator Engine REST import |
| Mirroring configs | Git-state | 1 h | JSON in Git + CDC re-bootstrap |
| Loom Direct-Lake-Shim | Stateless | 30 min | Redeploy container; Event Grid subscription re-binds |
| Purview catalog | Custom backup | 4-8 h | Customer-managed backup pattern (no native cross-region failover for Purview) |
| Loom Copilot agents | Cosmos backup | 1 h | Cosmos geo-replication |

## Region pairs

Per Microsoft Azure paired-region rules:

| Boundary | Primary ↔ Secondary |
|---|---|
| Commercial | eastus2 ↔ centralus; eastus ↔ westus; westeurope ↔ northeurope |
| GCC | Same as Commercial (Azure public regions) |
| GCC-High / IL4 | usgovvirginia ↔ usgovtexas |
| IL5 (v1.1) | usdodcentral ↔ usdodeast OR usgovvirginia + IL5 isolation ↔ usgovtexas + IL5 isolation |

Bicep parameterizes both primary + secondary regions; DR drills
exercise the failover quarterly.

## DR drill pattern (quarterly)

```bash
# 1. Stand up secondary-region Loom Admin Plane in clean RG
azd env new dr-drill-$(date +%Y-%m)
azd env set AZURE_LOCATION usgovtexas    # secondary for GCC-H
azd env set CSA_LOOM_BOUNDARY GCC-High
azd up

# 2. Verify Console comes up
curl -i https://<secondary-console-url>/api/health

# 3. Failover storage to secondary read endpoint
# (RA-GRS already readable; no action needed for reads)

# 4. Re-deploy a single workspace from Git
# (validates Git-state restoration)

# 5. Tear down DR-drill RG
azd down --purge --force
```

## ADLS Gen2 failover

For storage account write failover:
- **Customer-initiated failover** for GRS accounts (manual trigger)
- **Microsoft-initiated failover** for region-wide outage (automatic
  for some service tiers)
- Post-failover, the storage account is GRS-single (lost geo-
  redundancy until manually re-paired)

## Databricks DR

Databricks workspaces don't have native cross-region failover. DR
pattern:
1. Notebooks + Repos in Git (Azure DevOps / GitHub)
2. Cluster configs in Bicep
3. UC metastore: Commercial / GCC has per-metastore region pinning;
   redeploy in secondary if metastore unavailable
4. Hive metastore (Gov): workspace-scoped; redeploy workspace +
   attach to same ADLS path

## ADX DR

ADX **follower cluster** pattern (v1.1):
- Primary cluster + follower cluster in paired region
- Follower auto-syncs schema + data from primary
- Failover = update Console connection string to follower endpoint

For v1, redeploy + re-ingest from ADLS continuous export.

## Power BI semantic model DR

- TMDL in Git → re-deploy via Power BI REST API
- Premium capacity is per-region; failover = re-create capacity in
  secondary region + re-deploy semantic models
- Power BI service handles report-level DR within boundary

## Cross-region testing

`fiab-dr-drill` script (in `platform/fiab/bicep/scripts/`) automates
the quarterly drill. Outputs:
- Pass/fail per-component
- RTO actuals (measured time to working secondary)
- RPO actuals (data loss observed)
- Remediation items if RTO/RPO targets missed

## Runbook

- [DR drill runbook (parent CSA)](../../runbooks/dr-drill.md) —
  extends with Loom-specific steps

## Related

- [Capacity management](capacity-management.md)
- [Upgrade & migration](upgrade-migration.md)
- Parent: [Disaster Recovery](../../DR.md), [Multi-Region](../../MULTI_REGION.md)
