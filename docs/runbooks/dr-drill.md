[Home](../../README.md) > [Docs](../index.md) > [Runbooks](index.md) > **DR Drill**

# DR Drill Runbook (CSA-0073)

!!! note
**Quick Summary**: Quarterly disaster-recovery drill that exercises
Cosmos PITR restore, ADLS soft-delete restore, and Key Vault secret
recovery against the LIVE Loom estate (canary-only, scratch restore
targets), plus the scratch-subscription Storage-failover and Bicep
rollback rehearsals. Automated via
[`.github/workflows/dr-drill.yml`](../../.github/workflows/dr-drill.yml)
on the first day of each quarter with on-demand `workflow_dispatch`.

This runbook operationalises [`docs/DR.md`](../DR.md) §4 ("Failover
Readiness — Quarterly Drill"). The parent DR document is the
authoritative reference for RPO/RTO targets, region pairing, and the
_real_ failover procedure; this document covers how we rehearse
recoverability safely so the runbook stays honest instead of rotting
between real incidents.

> **loom-next-level WS-DR (2026-07):** DR1–DR3 deepened this framework
> from echo-stubs into real drills with validators that assert **real
> restored state** (document counts, byte hashes, secret values) and emit
> per-scenario RPO/RTO reports (`test-results/dr/<scenario>-<id>.json`,
> uploaded as run artifacts). DR4 (Phase 2) adds the run-level summary,
> Blob persistence for the Health & Reliability hub's DR-drills tab, and
> action-group alerting.

## 📑 Table of Contents

- [🎯 1. Objectives](#1-objectives)
- [📅 2. Cadence](#2-cadence)
- [🔐 3. Required Azure Permissions](#3-required-azure-permissions)
- [🧪 4. Scenarios](#4-scenarios)
    - [4.1 cosmos-pitr-restore](#41-cosmos-pitr-restore)
    - [4.2 storage-failover](#42-storage-failover)
    - [4.3 keyvault-restore](#43-keyvault-restore)
    - [4.4 bicep-rollback](#44-bicep-rollback)
    - [4.5 adls-softdelete-restore](#45-adls-softdelete-restore)
- [🚀 5. Triggering a Drill](#5-triggering-a-drill)
- [📊 6. Results & Reporting](#6-results-reporting)
- [📐 7. RPO / RTO Expectations](#7-rpo-rto-expectations)
- [🧰 8. Follow-up Work](#8-follow-up-work)
- [🔗 9. Related Documentation](#9-related-documentation)

---

## 🎯 1. Objectives

A DR drill is successful when:

1. Every scenario executes end-to-end without human intervention during
   the automated portion.
2. Observed RTO per scenario is within the target documented in §7 (and
   cross-referenced to [`docs/DR.md`](../DR.md) §1).
3. Each deepened scenario's validator report
   (`test-results/dr/<scenario>-<drillId>.json`) shows `ok: true` — the
   validators assert **real restored state** (restored document counts vs
   a live snapshot, byte-for-byte canary hashes, recovered secret
   values), never exit-code-only az calls.
4. Any deviation, flake, or gap is captured as a follow-up GitHub issue
   labelled `dr-drill-followup` so the runbook can be updated before the
   next drill.

Drills never mutate resources that real workloads depend on. The
deepened scenarios touch the live estate **only** through:

- **read-only restore sources** (Cosmos PITR restores never modify the
  source account),
- **namespaced canaries** (`drdrill-<id>` filesystems / secrets) that
  are swept in `always()` steps, and
- **per-run scratch resource groups** (`rg-csa-loom-drdrill-<cloud>-<id>`)
  that are deleted — and asserted deleted — in `always()`.

---

## 📅 2. Cadence

- **Scheduled:** `cron: "0 10 1 1,4,7,10 *"` — 10:00 UTC on the 1st day
  of Jan, Apr, Jul, and Oct.
- **On-demand:** via GitHub → Actions → `dr-drill` → _Run workflow_.
  Anyone with `write` access to the repository can trigger a drill.
- **Ad hoc post-incident:** after any real DR event, re-run the
  relevant scenario within five business days to confirm the
  post-incident patch is effective.

---

## 🔐 3. Required Azure Permissions

Two credential sets are in play:

**Deepened live-estate scenarios** (`cosmos-pitr-restore`,
`adls-softdelete-restore`, `keyvault-restore`) authenticate with the same
secret-based creds block the proven `loom-roll-and-validate.yml` uses —
`AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` /
`AZURE_SUBSCRIPTION_ID` (Gov: the `AZURE_GOV_*` set + the `cloud: gov`
and `live_rg` dispatch inputs). That SP needs:

| Scope                                   | Role / permission                                                                                       | Why                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| live subscription(s)                    | **CosmosRestoreOperator** + `restorableDatabaseAccounts/*/read` (Contributor covers both)               | Trigger PITR restores of the live accounts                             |
| live subscription(s)                    | RG create/delete (Contributor)                                                                          | Per-run scratch RGs `rg-csa-loom-drdrill-*`                            |
| lake storage account (`saloom*`)        | **Storage Blob Data Contributor** (data-plane) + Contributor (firewall window)                          | `adls-softdelete-restore` canary drill                                 |
| admin-plane vault (`kv-loom-*`)         | **Key Vault Secrets Officer** (RBAC) + Contributor (firewall window)                                    | `keyvault-restore` canary drill (set/delete/recover/purge-attempt)     |
| Microsoft Graph                         | ability to `az ad sp show --id <its own appId>` (default for most SPs)                                  | Resolve its object id to self-grant Cosmos data-plane on scratch accts |

The Cosmos data-plane role on the **restored scratch accounts** is granted
by the drill itself (`Cosmos DB Built-in Data Contributor`, scope `/`) —
no standing data-plane grant on the live Loom store is needed or used.

**Legacy scratch scenarios** (`storage-failover`, `bicep-rollback`) keep
the original scratch-subscription OIDC login: the SP behind
`AZURE_CLIENT_ID` needs Contributor on `AZURE_SUBSCRIPTION_ID_SCRATCH`.
The scratch scenarios **must not** use the production subscription secret.

!!! warning
Real storage-account failovers drop the account to LRS and the
replication seed can take hours to rebuild. That is fine on a
scratch account; do **not** run the storage-failover scenario
against staging or prod. (The new `adls-softdelete-restore` scenario
is canary-only and IS safe on the live lake.)

**PE-only resources.** The lake and vault are `publicNetworkAccess:
Disabled` + default-action Deny. The drill opens a **single-IP firewall
window** for the runner (default-action stays Deny — never `Allow`),
polls for data-plane reachability, and re-locks in `always()` — the same
pattern `csa-loom-post-deploy-bootstrap.yml` uses. Restored scratch
Cosmos accounts are created with public access **Enabled** (they hold
PITR copies of Loom metadata for minutes, are AAD-data-plane-only, and
are deleted in `always()` with an `az group exists → false` receipt).

---

## 🧪 4. Scenarios

Each scenario maps to one job in
[`.github/workflows/dr-drill.yml`](../../.github/workflows/dr-drill.yml).
Scenarios can be run individually via the `scenarios` input (see §5).

### 4.1 cosmos-pitr-restore

_(formerly `cosmos-failover` — the alias is still accepted by the
`scenarios` input. Renamed because the shipped Loom store is a
**single-region, PE-only** account — see
[`docs/fiab/runbooks/cosmos-pitr-restore.md`](../fiab/runbooks/cosmos-pitr-restore.md) —
so a failover-priority swap is not its real recoverability primitive;
**point-in-time restore is**. The multi-region failover rehearsal remains
documented in [`docs/DR.md`](../DR.md) §3 for the reference architecture.)_

**Purpose:** Prove the Loom metadata store — and the landing-zone
graph/vector Cosmos pair, which was previously in **no** drill's
validation set — is actually restorable inside the PITR window
(`Continuous30Days` on the admin store per DR0; `Continuous7Days` on the
landing-zone accounts).

**Behaviour** (implemented; per
[`docs/fiab/runbooks/cosmos-pitr-restore.md`](../fiab/runbooks/cosmos-pitr-restore.md)):

1. Discover the admin-plane account carrying the `loom` database, plus
   the `cosmos-loom-vec-*` / `cosmos-loom-gremlin-*` landing-zone
   accounts (Resource Graph; skipped with a note if the estate has none).
2. Snapshot live per-collection counts via the Azure Monitor
   `DocumentCount` metric (the live account is PE-only; the metric is the
   reachable live signal from a hosted runner).
3. `az cosmosdb restore` each account to `now − 10 min` into the per-run
   scratch RG (`rg-csa-loom-drdrill-<cloud>-<id>`, same subscription as
   each source — PITR cannot cross subscriptions), restores running in
   parallel.
4. Grant the drill SP `Cosmos DB Built-in Data Contributor` on the
   restored SQL accounts.
5. Run [`scripts/csa-loom/dr/validate-cosmos-restore.mjs`](../../scripts/csa-loom/dr/validate-cosmos-restore.mjs).
6. `always()`: delete the scratch RG(s) and assert `az group exists →
   false` (cost control receipt).

**Verification (the validator's real-state checks):**

- Restored `loom` database lists its containers; every container is
  counted with cross-partition data-plane reads.
- Floors: `loom-workspaces ≥ 1`, `env-config ≥ 1` (overridable via
  `FLOORS_JSON`).
- Restored counts within a tolerance band (±max(25, 10%)) of the live
  metric snapshot, where datapoints exist.
- Schema probes: a sampled doc from `loom-workspaces` (`id`, `tenantId`)
  and `env-config` (`id`) deserializes with its identity fields.
- Vector account: restored `loom-vectors/docs-vec` container readable +
  counted. Gremlin account: restored `loom-graph` database + `default`
  graph present (structure-level; gremlin data-plane needs an in-VNet
  client — documented limitation until DR4).
- `rpoEvidence`: restore timestamp + restore-point age;
  end-to-end duration = observed RTO.

**Rollback path:** none needed on the live side — restore never touches
the source account. If teardown fails, delete
`rg-csa-loom-drdrill-<cloud>-<id>` manually (it is tagged
`purpose=dr-drill autodelete=true`).

### 4.2 storage-failover

**Purpose:** Validate customer-initiated failover on an RA-GRS storage
account (`az storage account failover`) and the subsequent re-enablement
of geo-replication. **Still a stub** (scratch subscription only) — see
§8. Distinct from §4.5: this rehearses _regional failover_ on a scratch
RA-GRS account; §4.5 proves _restore_ on the live (ZRS/HNS) lake.

**Expected behaviour / verification / rollback:** unchanged from the
original CSA-0073 design — provision scratch `Standard_RAGRS` account,
failover, verify sentinel blob, reset SKU. Do not run against staging or
prod.

### 4.3 keyvault-restore

**Purpose:** Validate soft-delete + purge-protection recovery on the
**live** admin-plane vault (`kv-loom-*` — `enableSoftDelete`, 90-day
retention, `enablePurgeProtection` per `keyvault.bicep`).

**Behaviour** (implemented —
[`scripts/csa-loom/dr/validate-kv-recovery.mjs`](../../scripts/csa-loom/dr/validate-kv-recovery.mjs)):

1. Posture asserts: soft delete ON, retention ≥ 7d, purge protection ON.
2. Canary 1 (`drdrill-canary-<id>`): set (random value) → delete → appears
   in `list-deleted` with a `scheduledPurgeDate` → `recover` → readable
   again → **value byte-for-byte equals the original**.
3. Canary 2 (`drdrill-purge-<id>`): set → delete → `az keyvault secret
   purge` → **must be rejected** by purge protection (the expected error
   is captured in the report). It stays soft-deleted and auto-purges at
   the end of the retention window — harmless, namespaced.
4. Canary 1 is re-deleted so the vault stays swept.

**Verification:** recovered value equality + the purge rejection are the
two hard gates; recovery duration is recorded as RTO evidence
(target < 15 min per §7).

**Rollback path:** none required — recovery is the happy path. If
recovery fails, the canary remains in soft-delete state and is purged
automatically at the end of the retention window.

### 4.4 bicep-rollback

**Purpose:** Validate that a previous `main.bicep` can be redeployed and
that `az deployment group what-if` produces a clean diff. **Still a
stub** — see §8. This scenario is also the rollback story that new Azure
Functions reference (loom-next-level master Function standard).

**Expected behaviour / verification / rollback:** unchanged from the
original CSA-0073 design (deploy `HEAD~1`, what-if, deploy, return to
`HEAD`, assert idempotent `noChange`).

### 4.5 adls-softdelete-restore

> **Redesign note (binding).** The original WS-DR spec named this
> scenario `adls-versioning-restore` (canary + prior-**version**
> promotion). That premise was corrected by DR0 (#2414, Learn-grounded):
> **blob versioning and blob point-in-time restore (`restorePolicy`) are
> both unsupported on HNS-enabled (ADLS Gen2) accounts**, and the Loom
> lake is HNS by design (`storage.bicep` `isHnsEnabled: true`, guarded by
> `hnsSupportsVersioning`). DR0 shipped the corrected posture — blob +
> container **soft delete** (`recycleRetentionDays` window) + change
> feed — so this drill validates **the restore path that actually
> exists**: soft-delete undelete, not version promotion.

**Purpose:** Prove lake data is recoverable via the shipped soft-delete
posture, on the **live** lake, canary-only.

**Behaviour** (implemented —
[`scripts/csa-loom/dr/validate-adls-restore.mjs`](../../scripts/csa-loom/dr/validate-adls-restore.mjs)):

1. Posture asserts (live ARM): `isHnsEnabled: true`; blob soft delete ON
   with its retention window; container soft delete ON; change feed ON;
   **versioning correctly OFF** (it being on would be posture drift —
   the combination is ARM-invalid on HNS).
2. Canary drill in a namespaced filesystem `drdrill-<id>`: upload
   `canary.txt` (sha256 recorded) → overwrite v2 → delete →
   `az storage fs list-deleted-path` → `az storage fs undelete-path` →
   download → **byte-for-byte hash match**. Restore duration recorded.
3. Container-level safety net: the drill filesystem is deleted and
   asserted to appear in the soft-deleted container list
   (`az storage container list --include-deleted`).
4. `always()`: the canary filesystem is removed and the lake firewall
   window is re-locked.

**Verification:** the hash match after undelete is the hard gate; the
posture block ensures a mis-provisioned estate (soft delete off) fails
loudly rather than silently losing its restore window.

**Rollback path:** none — the drill only ever touches its namespaced
canary filesystem. If cleanup fails, delete the `drdrill-<id>` filesystem
manually; it contains only canary text.

---

## 🚀 5. Triggering a Drill

### Scheduled run

No action required. The cron entry in `dr-drill.yml` fires on the 1st of
each quarter at 10:00 UTC (Commercial estate, all scenarios). The
`report` job posts results even if one or more scenarios fail.

### Manual run (all scenarios)

```bash
gh workflow run dr-drill.yml \
  -f environment=scratch \
  -f scenarios=all
```

### Manual run (single scenario)

Use the `scenarios` input to restrict to one of:
`cosmos-pitr-restore` (alias `cosmos-failover`),
`adls-softdelete-restore`, `keyvault-restore`, `storage-failover`,
`bicep-rollback`. Comma-separated values are accepted.

```bash
gh workflow run dr-drill.yml \
  -f environment=scratch \
  -f scenarios=cosmos-pitr-restore
```

### Running against Azure Government

The deepened scenarios accept a `cloud` input. Gov requires the
`AZURE_GOV_*` secrets (same SP as `gov-console-roll.yml`,
`csa-loom-gov-deploy`) plus the Gov admin-plane RG name:

```bash
gh workflow run dr-drill.yml \
  -f scenarios=keyvault-restore \
  -f cloud=gov \
  -f live_rg=<gov admin-plane RG>
```

`az cosmosdb restore`, storage soft-delete, and KV recovery are all
supported in Azure Government (`.us` endpoints are resolved from the
resources themselves, never hard-coded). The Gov SP needs the same §3
grants in the Gov tenant.

### Running against `staging`

The `environment` input maps to the GitHub environment (approval gate).
`staging` is allowed only for `bicep-rollback` and `keyvault-restore`
and only with explicit sign-off from the on-call lead.

---

## 📊 6. Results & Reporting

- Each deepened scenario writes
  `test-results/dr/<scenario>-<drillId>.json` — schema:
  `{ drillId, scenario, cloud, startedAt, finishedAt, durationMs, ok,
  rpoEvidence, checks: [{ name, ok, ms, detail }] }` — and uploads it as
  the `dr-report-<scenario>` artifact on the run.
- The `report` job aggregates per-scenario `needs.<job>.result` and
  prints a summary line per scenario.
- Any scenario returning `failure` must open a GitHub issue labelled
  `dr-drill-followup` within one business day.
- **DR4 (Phase 2)** persists the reports to the `dr-drills` Blob
  container, renders them on the Health & Reliability hub's DR-drills
  tab, and wires failure alerting through the shared action group
  (`LOOM_ALERT_ACTION_GROUP_ID`).

---

## 📐 7. RPO / RTO Expectations

These expectations must stay aligned with
[`docs/DR.md`](../DR.md) §1. If they drift, update both files in the
same PR.

| Scenario                  | RPO (data-loss window)                                        | RTO (recovery time)     | Source of truth                                            |
| ------------------------- | ------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `cosmos-pitr-restore`     | restore-point age (drill uses `now − 10 min`; window = backup tier: 30d admin store / 7d landing-zone) | < 2 h (restore + validate; observed duration in the report) | [`cosmos-pitr-restore.md`](../fiab/runbooks/cosmos-pitr-restore.md) + DR.md §1 |
| `adls-softdelete-restore` | soft-delete window (`recycleRetentionDays`, default 30d)      | < 15 min (undelete)     | DR0 posture (`storage.bicep`)                              |
| `storage-failover`        | < 1 h                                                          | < 1 h                   | DR.md §1 (Data Lake Storage Silver + Gold, Critical tier)  |
| `keyvault-restore`        | N/A (recovery from soft-delete, not replication)               | < 15 min                | DR.md §1 (Key Vault, Critical tier)                        |
| `bicep-rollback`          | N/A (IaC redeploy, no runtime data)                            | < 30 min                | `docs/ROLLBACK.md`                                         |

If a drill's observed RTO exceeds the target by > 25%, treat it as a
finding and open a follow-up issue — do not silently accept drift.

---

## 🧰 8. Follow-up Work

Implemented by loom-next-level WS-DR (2026-07, DR1–DR3):

- [x] Cosmos scenario wired end-to-end (PITR restore + validator —
      `scripts/csa-loom/dr/validate-cosmos-restore.mjs`), including the
      landing-zone graph/vector accounts.
- [x] Key Vault scenario wired end-to-end
      (`scripts/csa-loom/dr/validate-kv-recovery.mjs`).
- [x] ADLS soft-delete restore scenario added
      (`scripts/csa-loom/dr/validate-adls-restore.mjs`) — redesigned from
      the unsupported versioning premise per DR0.
- [x] Per-scenario report artifacts with per-step durations (RPO/RTO
      evidence).

Still open:

- [ ] Implement `scripts/drill/storage-failover.sh` (scratch RA-GRS
      failover rehearsal — §4.2).
- [ ] Implement `scripts/drill/bicep-rollback.sh` (§4.4).
- [ ] **DR4 (Phase 2):** run-level `dr-summary-<id>.json`, Blob
      persistence (`dr-drills` container), the Health & Reliability hub
      DR-drills tab (+ "Run drill now"), failure alerting via
      `LOOM_ALERT_ACTION_GROUP_ID`, dedup GitHub issues, and the
      `svc-dr-drill` freshness gate row. The `dr-drill-rbac.bicep`
      role-assignment module for a dedicated drill principal also lands
      with DR4 (today the drill documents its grants in §3).
- [ ] Publish per-step duration metrics to Log Analytics for
      cross-quarter trend analysis.

---

## 🔗 9. Related Documentation

- [Disaster Recovery](../DR.md) — Authoritative DR runbook (RPO/RTO,
  region pairing, real failover procedure)
- [Loom shipped DR posture](../fiab/operations/disaster-recovery.md) —
  per-component posture of the actual shipped platform
- [Cosmos PITR restore runbook](../fiab/runbooks/cosmos-pitr-restore.md)
  — the manual restore procedure the cosmos scenario automates a
  rehearsal of
- [Rollback](../ROLLBACK.md) — Deployment rollback procedure
- [Security Incident](./security-incident.md) — Sibling operations
  runbook
- [Multi-Region Deployment](../MULTI_REGION.md) — Multi-region
  deployment guide
- [`.github/workflows/dr-drill.yml`](../../.github/workflows/dr-drill.yml) — The drill workflow itself
