[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **DR Drill**

# DR Drill Runbook (CSA-0073)

> **Last Updated:** 2026-04-19 | **Status:** Active | **Audience:** Operations, Platform Engineering

> [!NOTE]
> **Quick Summary**: Quarterly disaster-recovery drill that exercises
> Cosmos failover, Storage failover, Key Vault restore, and Bicep
> rollback against a scratch subscription. Automated via
> [`.github/workflows/dr-drill.yml`](../../.github/workflows/dr-drill.yml)
> on the first day of each quarter with on-demand `workflow_dispatch`.

This runbook operationalises [`docs/DR.md`](../DR.md) §4 ("Failover
Readiness — Quarterly Drill"). The parent DR document is the
authoritative reference for RPO/RTO targets, region pairing, and the
*real* failover procedure; this document covers how we rehearse that
procedure safely against a scratch subscription so the runbook stays
honest instead of rotting between real incidents.

## 📑 Table of Contents

- [🎯 1. Objectives](#-1-objectives)
- [📅 2. Cadence](#-2-cadence)
- [🔐 3. Required Azure Permissions](#-3-required-azure-permissions)
- [🧪 4. Scenarios](#-4-scenarios)
  - [4.1 cosmos-failover](#41-cosmos-failover)
  - [4.2 storage-failover](#42-storage-failover)
  - [4.3 keyvault-restore](#43-keyvault-restore)
  - [4.4 bicep-rollback](#44-bicep-rollback)
- [🚀 5. Triggering a Drill](#-5-triggering-a-drill)
- [📊 6. Results & Reporting](#-6-results--reporting)
- [📐 7. RPO / RTO Expectations](#-7-rpo--rto-expectations)
- [🧰 8. Follow-up Work](#-8-follow-up-work)
- [🔗 9. Related Documentation](#-9-related-documentation)

---

## 🎯 1. Objectives

A DR drill is successful when:

1. Every scenario executes end-to-end without human intervention during
   the automated portion.
2. Observed RTO per scenario is within the target documented in §7 (and
   cross-referenced to [`docs/DR.md`](../DR.md) §1).
3. The drill report is posted to the ops channel and archived by the
   workflow's `report` job.
4. Any deviation, flake, or gap is captured as a follow-up task in
   Archon under the "DR" tag so the runbook can be updated before the
   next drill.

Drills are **not** a deployment. They never target production and must
never mutate resources that real workloads depend on.

---

## 📅 2. Cadence

- **Scheduled:** `cron: "0 10 1 1,4,7,10 *"` — 10:00 UTC on the 1st day
  of Jan, Apr, Jul, and Oct.
- **On-demand:** via GitHub → Actions → `dr-drill` → *Run workflow*.
  Anyone with `write` access to the repository can trigger a drill.
- **Ad hoc post-incident:** after any real DR event, re-run the
  relevant scenario within five business days to confirm the
  post-incident patch is effective.

---

## 🔐 3. Required Azure Permissions

The drill workflow authenticates via OIDC federated credentials. The
service principal behind `AZURE_CLIENT_ID` needs:

| Scope | Role | Why |
|---|---|---|
| `subscriptions/$SCRATCH_SUB` | **Contributor** | Create + mutate resources during the drill |
| `subscriptions/$SCRATCH_SUB` | **User Access Administrator** (optional) | Only if the drill provisions role assignments |
| `subscriptions/$SCRATCH_SUB/providers/Microsoft.KeyVault` | **Key Vault Administrator** (RBAC model) or vault access-policy entry with `get / list / recover / purge` | Required by `keyvault-restore` |
| `subscriptions/$SCRATCH_SUB/providers/Microsoft.DocumentDB` | **Cosmos DB Operator** | Required by `cosmos-failover` |
| `subscriptions/$SCRATCH_SUB/providers/Microsoft.Storage` | **Storage Account Contributor** | Required by `storage-failover` |

The scratch subscription ID is stored in the repository secret
`AZURE_SUBSCRIPTION_ID_SCRATCH`. The tenant is the usual
`AZURE_TENANT_ID`. The drill **must not** use the production
subscription secret.

> [!WARNING]
> Real storage-account failovers drop the account to LRS and the
> replication seed can take hours to rebuild. That is fine on a
> scratch account; do **not** run the storage-failover scenario
> against staging or prod.

---

## 🧪 4. Scenarios

Each scenario maps to one job in
[`.github/workflows/dr-drill.yml`](../../.github/workflows/dr-drill.yml).
Scenarios can be run individually via the `scenarios` input (see §5).

### 4.1 cosmos-failover

**Purpose:** Validate Cosmos DB multi-region write + automatic failover
using `az cosmosdb failover-priority-change`.

**Expected behaviour:**
1. Drill provisions (or reuses) a 2-region Cosmos account in the
   scratch subscription with `enableAutomaticFailover=true` and
   `enableMultipleWriteLocations=true`.
2. Write a sentinel document to the primary region.
3. Force a failover-priority swap so the former secondary becomes the
   new primary.
4. Re-read the sentinel document from the new primary.
5. Swap priorities back (failback).

**Verification:**
- Read after failover must return the sentinel.
- `az cosmosdb show` reflects the expected priority order post-failback.
- End-to-end duration logged for RTO comparison.

**Rollback path:** Scenario always finishes by restoring the original
priority order. On failure, the on-call runs
`az cosmosdb failover-priority-change` manually using the commands in
[`docs/DR.md`](../DR.md) §5.2.

### 4.2 storage-failover

**Purpose:** Validate customer-initiated failover on an RA-GRS storage
account (`az storage account failover`) and the subsequent re-
enablement of geo-replication.

**Expected behaviour:**
1. Drill provisions (or reuses) a scratch `Standard_RAGRS` storage
   account with a small test container + blob.
2. Invoke `az storage account failover --yes`.
3. Confirm the blob is readable from the failover region and that the
   account SKU is now `Standard_LRS`.
4. Set SKU back to `Standard_RAGRS` and wait for
   `geoReplicationStatus=Live`.

**Verification:**
- Blob content matches the pre-failover sentinel.
- `az storage account show` reports the expected primary region.
- Failback SKU update succeeds (seed time is logged, not asserted — it
  can legitimately take hours).

**Rollback path:** The scenario's final step always resets the SKU to
`Standard_RAGRS`. If it fails, the steady-state scratch environment is
left in LRS — operator reruns the SKU update manually.

### 4.3 keyvault-restore

**Purpose:** Validate soft-delete + purge-protection recovery using a
Key Vault with 90-day soft-delete retention.

**Expected behaviour:**
1. Drill creates a secret in a scratch Key Vault.
2. Deletes the secret (soft delete).
3. Lists deleted secrets and asserts the secret is present with the
   expected `scheduledPurgeDate`.
4. Recovers the secret via `az keyvault secret recover`.
5. Confirms the recovered secret value matches the original.

**Verification:**
- Recovered value byte-for-byte equals the original.
- Key Vault emits audit events for `SecretDelete` and `SecretRecover`
  (cross-checked against the tamper-evident audit logger wired in
  CSA-0016).

**Rollback path:** None required — recovery is the happy path. If
recovery fails, the secret remains in soft-delete state and is purged
automatically at the end of the retention window.

### 4.4 bicep-rollback

**Purpose:** Validate that a previous `main.bicep` can be redeployed
and that `az deployment group what-if` produces a clean diff.

**Expected behaviour:**
1. Drill checks out the `main.bicep` at `HEAD~1` (or a pinned "known
   good" tag).
2. Runs `az deployment group what-if` against the scratch RG and
   records the diff.
3. Executes the deployment.
4. Redeploys the current `HEAD` `main.bicep` and confirms the
   resource graph returns to the expected state.

**Verification:**
- `what-if` exits 0.
- Deployment success is captured in `az deployment group show`.
- Return-to-HEAD deployment is idempotent (`noChange` result).

**Rollback path:** The scenario always finishes by redeploying `HEAD`,
so the scratch RG is left in the current-main state. If any step
fails, operator runs the deployment manually per
[`docs/ROLLBACK.md`](../ROLLBACK.md).

---

## 🚀 5. Triggering a Drill

### Scheduled run

No action required. The cron entry in `dr-drill.yml` fires on the 1st
of each quarter at 10:00 UTC. The `report` job posts results even if
one or more scenarios fail.

### Manual run (all scenarios)

```bash
gh workflow run dr-drill.yml \
  -f environment=scratch \
  -f scenarios=all
```

### Manual run (single scenario)

Use the `scenarios` input to restrict to one of:
`cosmos-failover`, `storage-failover`, `keyvault-restore`,
`bicep-rollback`.

```bash
gh workflow run dr-drill.yml \
  -f environment=scratch \
  -f scenarios=cosmos-failover
```

Comma-separated values are also accepted:

```bash
gh workflow run dr-drill.yml \
  -f environment=scratch \
  -f scenarios=cosmos-failover,keyvault-restore
```

### Running against `staging`

Allowed only for the `bicep-rollback` and `keyvault-restore` scenarios
and only with explicit sign-off from the on-call lead. Storage and
Cosmos failover in staging is prohibited because it affects shared
paired resources.

```bash
gh workflow run dr-drill.yml \
  -f environment=staging \
  -f scenarios=keyvault-restore
```

---

## 📊 6. Results & Reporting

- The `report` job in the workflow aggregates per-scenario
  `needs.<job>.result` and prints a summary line per scenario
  (`success | failure | cancelled | skipped`).
- Results are posted to the ops Teams channel via the webhook stub in
  the `report` job (wiring TODO — see §8).
- Archive the workflow run URL plus the drill ID (format
  `drill-YYYYMMDDTHHMMSSZ`) under
  `reports/dr-drills/<date>.md` in the ops tracker. The file is
  gitignored — attach it to the Archon "DR drills" document instead.
- Any scenario returning `failure` must open an Archon task tagged
  `dr-drill-followup` within one business day.

---

## 📐 7. RPO / RTO Expectations

These expectations must stay aligned with
[`docs/DR.md`](../DR.md) §1. If they drift, update both files in the
same PR.

| Scenario | RPO (data-loss window) | RTO (recovery time) | Source of truth |
|---|---|---|---|
| `cosmos-failover` | < 15 min | < 30 min | DR.md §1 (Cosmos DB, Critical tier) |
| `storage-failover` | < 1 h | < 1 h | DR.md §1 (Data Lake Storage Silver + Gold, Critical tier) |
| `keyvault-restore` | N/A (recovery from soft-delete, not replication) | < 15 min | DR.md §1 (Key Vault, Critical tier) |
| `bicep-rollback` | N/A (IaC redeploy, no runtime data) | < 30 min | `docs/ROLLBACK.md` |

If a drill's observed RTO exceeds the target by > 25%, treat it as a
finding and open a follow-up task — do not silently accept drift.

---

## 🧰 8. Follow-up Work

The workflow lands as a shell with each scenario as an
`echo "TODO: wire to scripts/drill/<scenario>.sh"` stub. The following
items are known follow-ups (not in scope for CSA-0073):

- [ ] Implement `scripts/drill/cosmos-failover.sh`.
- [ ] Implement `scripts/drill/storage-failover.sh`.
- [ ] Implement `scripts/drill/keyvault-restore.sh`.
- [ ] Implement `scripts/drill/bicep-rollback.sh`.
- [ ] Wire the `report` job's Teams webhook POST
      (`TEAMS_OPS_WEBHOOK` secret, not yet created).
- [ ] Add a scratch-subscription Bicep module under
      `deploy/bicep/scratch/` for idempotent provisioning of the
      drill fixtures (Cosmos + Storage + KV + empty RG).
- [ ] Extend the drill `report` job to write an artifact into
      `reports/dr-drills/` and attach it to the Archon DR drills doc.
- [ ] Capture per-step duration metrics and publish them to Log
      Analytics so trend analysis is possible across quarters.

---

## 🔗 9. Related Documentation

- [Disaster Recovery](../DR.md) — Authoritative DR runbook (RPO/RTO,
  region pairing, real failover procedure)
- [Rollback](../ROLLBACK.md) — Deployment rollback procedure
- [Security Incident](./security-incident.md) — Sibling operations
  runbook
- [Multi-Region Deployment](../MULTI_REGION.md) — Multi-region
  deployment guide
- [`.github/workflows/dr-drill.yml`](../../.github/workflows/dr-drill.yml) — The drill workflow itself
