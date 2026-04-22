[Home](../README.md) > [Docs](./) > **Rollback**

# Deployment Rollback Runbook

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Operations

!!! note
    **Quick Summary**: Step-by-step rollback procedures for failed CSA-in-a-Box deployments — Bicep landing zone redeployment from git tags, ADF pipeline restore, dbt model full-refresh, Cosmos DB point-in-time restore, and storage account blob/container recovery via soft-delete and versioning.

This runbook covers how to recover from a failed or bad deployment. It pairs
with the `Rollback Deployment` GitHub Actions workflow
(`.github/workflows/rollback.yml`) and the point-in-time restore features
wired into the Bicep modules.

!!! danger
    **Before you start:** rollback is a high-risk, privileged operation. Always
    run the rollback workflow in `dry_run: true` mode first, read the what-if
    output, and only flip to a real rollback once the blast radius is clear.

## 📑 Table of Contents

- [🏷️ 1. Rollback Targets](#️-1-rollback-targets)
- [📦 2. Landing Zone (Bicep) Rollback](#-2-landing-zone-bicep-rollback)
  - [When a rollback is the wrong tool](#when-a-rollback-is-the-wrong-tool)
- [🔧 3. ADF Pipeline Rollback](#-3-adf-pipeline-rollback)
- [🗄️ 4. dbt Model Rollback](#️-4-dbt-model-rollback)
- [🔄 5. Cosmos DB Point-in-Time Restore](#-5-cosmos-db-point-in-time-restore)
- [💾 6. Storage Account Data Recovery](#-6-storage-account-data-recovery)
- [✅ 7. Post-Rollback Checklist](#-7-post-rollback-checklist)
- [🧪 8. Testing Cadence](#-8-testing-cadence)

---

## 🏷️ 1. Rollback Targets

Every successful, non-dry-run run of the `Deploy Infrastructure` workflow
pushes a tag of the form:

```text
deploy/<environment>-<short-sha>-<run-number>
```

For example: `deploy/prod-9f3a1e2-47`. These tags are the canonical rollback
targets — pass one to the Rollback workflow's `rollback_ref` input to
redeploy that exact commit.

List recent deploy tags locally:

```bash
git fetch --tags
git tag --list 'deploy/*' --sort=-creatordate | head -20
```

---

## 📦 2. Landing Zone (Bicep) Rollback

This is the most common path: the last infrastructure deploy broke something,
and you want to return the subscription to the previous good state.

- [ ] In GitHub, go to **Actions → Rollback Deployment → Run workflow**.
- [ ] Fill in the inputs:
  - `environment`: `dev`, `test`, or `prod` — must match where the bad
    deploy landed.
  - `target`: `alz`, `dmlz`, `dlz`, or `all`.
    - Prefer the narrowest target you can justify.
  - `rollback_ref`: the `deploy/<env>-<sha>-<run>` tag from the last
    known-good deploy, or any git ref / SHA that still contains the Bicep
    templates.
  - `confirm`: type exactly `ROLLBACK`. The preflight job will refuse to
    continue otherwise.
  - `dry_run`: **leave this `true` for the first run.** Review the what-if
    output, then re-run with `dry_run: false`.
- [ ] The workflow runs a preflight, then redeploys the selected landing zones
   at the rollback ref, then runs the post-rollback verification job.

### When a rollback is the wrong tool

!!! warning
    - **Schema-changing dbt deploys.** Bicep rollback will not undo Delta table
      schema changes. Use dbt model rollback (section 4) first, *then* Bicep if
      needed.
    - **Resource deletions.** If the bad deploy deleted resources, plain Bicep
      redeploy will not recreate data inside them. Use PITR (section 5) or
      storage soft-delete (section 6) to restore data first, then redeploy.

---

## 🔧 3. ADF Pipeline Rollback

ADF pipeline definitions live in the repo under
`domains/shared/pipelines/adf/`. They are deployed by importing the JSON
into the ADF instance; there is no per-pipeline rollback primitive in
Azure.

**Procedure:**

- [ ] `git checkout <good-ref> -- domains/shared/pipelines/adf/`
- [ ] Import the pipeline JSON files into the ADF instance (via the ADF
   Studio "Import ARM template" or your CI step).
- [ ] Publish and re-trigger.

!!! note
    **Prevention:** Always run the `Bicep What-If` workflow on a PR that
    touches ADF JSON so what-if rejects structurally invalid pipeline changes
    before they land.

---

## 🗄️ 4. dbt Model Rollback

Rolling back a Delta model means running the *previous* version of the
model SQL so the new version's output gets overwritten by a fresh
merge/insert.

**Procedure:**

- [ ] `git checkout <good-ref> -- domains/shared/dbt/models/`
- [ ] Run a full-refresh for the affected models:

    ```bash
    cd domains/shared/dbt
    dbt run --select <model_name>+ --full-refresh --target <env>
    ```

- [ ] Re-run the dependent gold models so the downstream state is consistent:

    ```bash
    dbt run --select gld_customer_lifetime_value gld_daily_order_metrics --full-refresh
    ```

- [ ] Verify the data-quality suite:

    ```bash
    python ../../csa_platform/governance/dataquality/run_quality_checks.py --suite all
    ```

!!! important
    If the bad deploy added new columns or dropped columns, you may have to
    drop the affected Delta tables by hand before the full-refresh.

---

## 🔄 5. Cosmos DB Point-in-Time Restore

Cosmos DB accounts now default to **Continuous / Continuous30Days** backup
(see `deploy/bicep/DLZ/modules/cosmos/cosmosdb.bicep`), which gives a 30-day
point-in-time restore window.

**Procedure:**

- [ ] Identify the timestamp just before the bad deploy from the
   `Deploy Infrastructure` workflow run log.
- [ ] Restore to a new account (Cosmos cannot in-place restore):

    ```bash
    az cosmosdb restore \
      --target-database-account-name csa-cosmos-restored \
      --account-name csa-cosmos-dlz \
      --resource-group rg-csa-cosmos \
      --location eastus \
      --restore-timestamp 2026-04-10T14:00:00Z
    ```

- [ ] Point the application at the restored account, validate, then rename
   the original and the restored account to swap them.
- [ ] Update the Bicep parameter file so the next deploy references the
   renamed account if you decide to keep the restored copy.

---

## 💾 6. Storage Account Data Recovery

The DLZ storage account now enables blob versioning, change feed, blob
soft-delete, container soft-delete, and a 6-day point-in-time restore
window. See `deploy/bicep/DLZ/modules/storage/storage.bicep`.

**To recover a deleted blob:**

```bash
az storage blob undelete \
  --account-name <storage-account> \
  --container-name <container> \
  --name <blob-path> \
  --auth-mode login
```

**To recover a deleted container:**

```bash
az storage container restore \
  --account-name <storage-account> \
  --name <container> \
  --deleted-version <version-id> \
  --auth-mode login
```

**To restore the entire account to an earlier point in time (up to 6 days):**

```bash
az storage account restore-blob-ranges \
  --account-name <storage-account> \
  --resource-group <rg> \
  --time-to-restore 2026-04-10T14:00:00Z \
  --blob-range-list '[{"start":"","end":""}]'
```

---

## ✅ 7. Post-Rollback Checklist

After any rollback, run through the following before declaring done:

- [ ] Confirm the affected workload is functioning (smoke test one
      representative dbt model + one representative ADF pipeline).
- [ ] Confirm data quality checks pass:
      `python csa_platform/governance/dataquality/run_quality_checks.py --suite all`.
- [ ] Tag the rolled-back state as `rollback/<env>-<sha>-<date>` for
      traceability.
- [ ] Open a tracking issue describing the root cause of the bad deploy
      and a prevention action (extra test, extra validation gate, etc.).
- [ ] Update `.claude/DEVELOPMENT_LOG.md` with a short entry so the next
      session has context.

---

## 🧪 8. Testing Cadence

Rollback procedures are only useful if they work. Run a rollback drill in
`dev` once per quarter, pointing to a known-good previous `deploy/dev-*`
tag. Capture the run URL in the development log and update this runbook if
anything drifts.

---

## 🔗 Related Documentation

- [Troubleshooting](TROUBLESHOOTING.md) — Common issues and fixes
- [Disaster Recovery](DR.md) — Multi-region failover runbook
- [Production Checklist](PRODUCTION_CHECKLIST.md) — Production readiness checklist
