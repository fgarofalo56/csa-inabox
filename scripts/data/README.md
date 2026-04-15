# Data Lifecycle Scripts

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** Developers

## Table of Contents

- [Scripts](#scripts)
- [Prerequisites](#prerequisites)
- [Backup Strategy](#backup-strategy)
  - [Incremental Backup](#incremental-backup)
  - [Retention Policy](#retention-policy)
  - [Scheduling](#scheduling)
- [Recovery Procedures](#recovery-procedures)
  - [Standard Restore](#standard-restore)
  - [Overwrite Existing Data](#overwrite-existing-data)
  - [Restore with VACUUM](#restore-with-vacuum)
  - [Dry Run](#dry-run)
- [Data Seeding for Development](#data-seeding-for-development)
- [Log Files](#log-files)

Shell scripts for managing Delta Lake table data on ADLS Gen2 across the CSA-in-a-Box medallion architecture.

## Scripts

| Script | Purpose |
|---|---|
| `backup-delta-tables.sh` | Incremental backup of Delta tables using azcopy |
| `restore-delta-tables.sh` | Restore Delta tables from a timestamped backup |
| `seed-sample-data.sh` | Upload seed CSVs and optionally generate synthetic data |

## Prerequisites

- **azcopy v10+** -- [Install guide](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azcopy-v10)
- **Azure CLI** (`az`) -- logged in with `az login` and appropriate storage permissions
- **Python 3.9+** with `faker` (only for synthetic data generation)

```bash
# Install azcopy (Linux)
curl -sL https://aka.ms/downloadazcopy-v10-linux | tar xz --strip-components=1 -C /usr/local/bin

# Install faker (optional)
pip install faker
```

## Backup Strategy

### Incremental Backup

The backup script uses `azcopy sync` which only transfers files that are new or changed since the last sync. Each backup is stored in a timestamped subdirectory.

```bash
./scripts/data/backup-delta-tables.sh \
    --source "https://myaccount.dfs.core.windows.net/gold/" \
    --dest   "https://myaccount.dfs.core.windows.net/backups/gold/" \
    --retention 7
```

This creates a backup at `backups/gold/20260412T120000Z/` and removes backups older than the 7 most recent.

### Retention Policy

The `--retention N` flag keeps only the last N timestamped backup directories. Older backups are automatically removed after a successful sync.

### Scheduling

For production environments, schedule backups via Azure Data Factory, Databricks Jobs, or cron:

```bash
# Cron example: daily backup at 2 AM UTC
0 2 * * * /path/to/scripts/data/backup-delta-tables.sh \
    --source "https://acct.dfs.core.windows.net/gold/" \
    --dest   "https://acct.dfs.core.windows.net/backups/gold/" \
    --retention 14
```

## Recovery Procedures

### Standard Restore

```bash
./scripts/data/restore-delta-tables.sh \
    --backup "https://myaccount.dfs.core.windows.net/backups/gold/20260412T120000Z/" \
    --target "https://myaccount.dfs.core.windows.net/gold-restored/"
```

### Overwrite Existing Data

```bash
./scripts/data/restore-delta-tables.sh \
    --backup "https://myaccount.dfs.core.windows.net/backups/gold/20260412T120000Z/" \
    --target "https://myaccount.dfs.core.windows.net/gold/" \
    --force
```

### Restore with VACUUM

After restoring, run VACUUM to clean up orphaned files:

```bash
./scripts/data/restore-delta-tables.sh \
    --backup "..." \
    --target "..." \
    --force --vacuum
```

Note: VACUUM requires a Spark environment (Databricks). The script will print the SQL command to run manually if Databricks CLI is not available.

### Dry Run

Both backup and restore scripts support `--dry-run` to preview operations without making changes:

```bash
./scripts/data/backup-delta-tables.sh --source "..." --dest "..." --dry-run
./scripts/data/restore-delta-tables.sh --backup "..." --target "..." --dry-run
```

## Data Seeding for Development

### Upload Existing Seeds

Upload the CSV files from `domains/shared/dbt/seeds/` to ADLS bronze layer:

```bash
./scripts/data/seed-sample-data.sh \
    --storage-account mydevaccount \
    --container bronze \
    --env dev
```

Seed files and their target paths:
- `sample_customers.csv` -> `bronze/shared/customers/`
- `sample_orders.csv` -> `bronze/shared/orders/`
- `sample_products.csv` -> `bronze/shared/products/`

### Generate Synthetic Data

Generate additional fake data for finance, inventory, and sales domains using Python/faker:

```bash
./scripts/data/seed-sample-data.sh \
    --storage-account mydevaccount \
    --container bronze \
    --env dev \
    --generate-synthetic \
    --synthetic-rows 5000
```

This creates:
- `synthetic_invoices.csv` -> `bronze/finance/invoices/`
- `synthetic_inventory.csv` -> `bronze/inventory/inventory/`
- `synthetic_sales_orders.csv` -> `bronze/sales/sales_orders/`

### Safety

The seed script **only runs in dev or test environments**. It will refuse to execute if `--env` is set to `staging`, `production`, or any production-like value.

## Log Files

All scripts write logs to `./temp/` (gitignored):
- `temp/backup-logs/backup_<timestamp>.log`
- `temp/restore-logs/restore_<timestamp>.log`
- `temp/seed-logs/seed_<timestamp>.log`

Metadata JSON files are written alongside logs for audit purposes.

---

## Related Documentation

- [Getting Started Guide](../../docs/GETTING_STARTED.md) - Platform setup and onboarding
- [Examples](../../examples/README.md) - Sample data pipelines and use cases
