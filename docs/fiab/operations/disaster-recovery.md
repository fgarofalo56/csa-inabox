# Disaster recovery

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.

## What the deployed platform actually provides (read this first)

CSA Loom ships as a **single-region deployment with zone redundancy**, not an
active/passive multi-region topology. There is **no GRS / RA-GRS storage, no
paired-region failover, and no follower/replica cluster** wired by default. DR is
built on three real, verifiable mechanisms:

1. **Zone redundancy inside the region** — the data-lake storage account is
   `Standard_ZRS` (`platform/fiab/bicep/modules/landing-zone/storage.bicep`), so
   it keeps three synchronous copies across availability zones and survives a
   single-zone outage transparently.
2. **Point-in-time restore (PITR) for stateful metadata** — the Console's Cosmos
   account runs **continuous backup, `Continuous7Days` tier**
   (`platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep`), giving
   restore to any second within the **last 7 days**.
3. **Redeploy-from-Git for stateless compute** — every app is a stateless
   container built from the repo; recovery is a bicep re-deploy + image roll, not
   a data restore.

Anything stronger than this (cross-region active/passive, geo-redundant backup)
is an **opt-in** the operator enables deliberately — see
[Stronger DR (opt-in)](#stronger-dr-opt-in) below. Claiming multi-region
failover that the bicep does not deploy would be a `no-vaporware`
(`.claude/rules/no-vaporware.md`) violation, which is why
this document was corrected.

## Real posture per component

| Component | Bicep SKU / policy | Zone loss | Region loss | Recovery mechanism |
|---|---|---|---|---|
| Data lake (ADLS Gen2) | `Standard_ZRS` (zone-redundant, single region) | Transparent (3 synchronous zone copies) | **Not auto-covered** — re-ingest from source, or opt into GZRS/GRS | Storage zone redundancy; source re-ingest for region loss |
| Console metadata (Cosmos) | Single write region, `isZoneRedundant:false`, `enableAutomaticFailover:false`, **Continuous 7-day PITR** | Azure-managed regional resilience | PITR restore (see caveat) | `az cosmosdb restore` → new account (runbook below) |
| Admin-plane utility storage | `Standard_LRS` (locally redundant) | Not zone-redundant | Not auto-covered | Redeploy; holds no source-of-truth data |
| Loom Console + parity apps | Stateless containers (ghcr/ACR images) | Restart on healthy nodes | Redeploy from Git in a new RG/region | `az deployment sub create` + in-product image roll |
| Synapse Serverless / ADX / Databricks | Stateless compute over the lake | Service-managed | Redeploy; re-attach to the (restored) lake | Bicep redeploy; external tables re-create |
| Item/object definitions (pipelines, activator rules, semantic models, dashboards) | JSON/TMDL persisted in Cosmos + exportable to Git | Covered by Cosmos PITR | Restore with the metadata store | PITR restore or Git re-import |

**Honest RPO / RTO** (single-region deployment; these are the numbers the above
mechanisms actually deliver — derive your own against your data sizes and drill
measurements):

| Scenario | RPO (data loss) | RTO (time to recover) | Notes |
|---|---|---|---|
| Single **zone** outage | ~0 | ~0 (transparent) for ZRS lake; minutes for Cosmos (Azure-managed) | The design point of a zone-redundant single-region deployment |
| Accidental data change / delete in Cosmos | **minutes** (continuous backup granularity) | **~1–2 h** (PITR provisions a new account + re-point Console) | Restore window = **7 days**; see runbook |
| Console/app corruption or bad image | 0 (no state in compute) | **~30–60 min** (bicep redeploy or image roll) | Stateless — nothing to restore |
| Full **region** loss | Depends: lake = last source ingest; Cosmos = last replicated backup | **Hours**, and gated on the opt-ins below | **Not auto-covered by default** — plan the opt-in if your mission requires it |

### Why "minutes", not "zero", for Cosmos RPO

Continuous backup is a near-real-time backup pipeline, not synchronous
replication. Microsoft documents second-level restore granularity; the practical,
honest RPO to plan against is **a few minutes** of the most recent writes. The
restore **window** is 7 days (the `Continuous7Days` tier we deploy).

### The region-loss caveat you must understand

The Console Cosmos account is **single-region** with **locally-redundant backup
storage** (continuous-mode backup blobs are LRS, or ZRS only in regions where
zone redundancy is configured — and you **cannot** change backup-storage
redundancy while in continuous mode). PITR restores into a region **where the
backup existed**. For a single-region account that means a genuine, total loss of
the home region is **not** recoverable by PITR alone until that region returns.
If your mission cannot accept that, enable the opt-in below.

## Cosmos PITR restore — the one tested runbook

The single, verifiable DR action for the stateful metadata store is a
point-in-time restore. Full step-by-step commands (grounded in Microsoft Learn)
live in the runbook:

- **[Cosmos DB point-in-time restore runbook](../runbooks/cosmos-pitr-restore.md)**

It covers: finding the restorable account instance id, choosing a restore
timestamp, running `az cosmosdb restore` into a new PE-disabled account,
re-pointing the Console (`LOOM_COSMOS_ACCOUNT` / endpoint) + re-granting the UAMI
data-plane role, and verifying item CRUD. Live execution is **operator-verified**
(a restore cannot be exercised from a docs build).

## Compute recovery — redeploy from Git

Loom compute holds no source-of-truth state, so "recovery" is a clean redeploy:

```bash
# 1. Deploy the platform into a clean resource group (same or new region).
az deployment sub create \
  --location <region> \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/<cloud>-full.bicepparam

# 2. Run the post-deploy bootstrap (see docs/fiab/deployment/*).

# 3. If the metadata store was lost, restore it first (runbook above) and set
#    LOOM_COSMOS_ACCOUNT / endpoint on loom-console before item CRUD is exercised.
```

Item and object definitions that were exported to Git (pipelines, activator
rules JSON, semantic-model TMDL, KQL dashboards) can be re-imported through their
editors after the platform is back up; anything not exported is recovered from
the Cosmos PITR restore.

## Stronger DR (opt-in)

If the mission requires cross-region survivability beyond the default
single-region + zone-redundant posture, these are the honest, real options — each
is an operator decision with cost and (for Cosmos multi-region) consistency
implications:

- **Geo-redundant data lake** — deploy the landing-zone storage as `Standard_GZRS`
  (zone + geo) or `Standard_GRS` instead of `ZRS`. This adds an asynchronously
  replicated secondary; failover is customer- or Microsoft-initiated and drops to
  a single copy post-failover until re-paired.
- **Multi-region Cosmos** — add a second `locations[]` region (and optionally
  `enableAutomaticFailover`) to `loom-console-cosmos.bicep`. Note: the account is
  currently **Serverless**, which requires a single write region — enabling
  multi-region write/failover means moving off Serverless to provisioned/autoscale
  throughput (a real trade-off, not a flag flip).
- **Geo-redundant Cosmos backup region** — with a multi-region account, continuous
  backups become restorable in the additional region, removing the region-loss
  caveat above.

Wire any of these through the bicep params and validate with a drill before
relying on them — do not assume a value in a doc equals a deployed capability.

## DR drill (what you can actually rehearse)

A meaningful drill for the shipped posture:

1. In a non-production sub, take a known-good Cosmos restore timestamp.
2. Run the [PITR restore runbook](../runbooks/cosmos-pitr-restore.md) into a new
   account; measure actual RTO.
3. Re-point a test Console at the restored account and confirm item/workspace
   CRUD returns real data.
4. Separately, redeploy the platform bicep into a clean RG and confirm the
   Console comes up (`/api/health` 200) and every editor renders or shows its
   honest infra-gate.
5. Record RTO/RPO actuals and any gaps.

## Related

- [Cosmos PITR restore runbook](../runbooks/cosmos-pitr-restore.md)
- [Capacity management](capacity-management.md)
- [Upgrade & migration](upgrade-migration.md)
- [Deployment — supported availability model](../deployment/quickstart.md#supported-availability-model)
