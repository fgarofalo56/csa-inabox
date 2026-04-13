# Session Knowledge

Live state for the current working session. Updated as work progresses.
The end-of-session protocol (`.claude/rules/session-end.md`) rewrites this at
the close of each session.

---

## Current Session — 2026-04-13

**Focus:** Fill all 7 remaining gaps in the CSA-in-a-Box platform to reach
100% completion.

**Archon project:** `1bd59749-db0a-4009-82c7-f1a56d24a820` — CSA-in-a-Box: Cloud-Scale Analytics Platform

### Outcome

**All 7 gaps addressed. 16 new files created, 7 files modified.**

#### Phase 1: ADF Deployment Automation
- `scripts/deploy/deploy-adf.sh` — Bash script that deploys linked services, datasets, pipelines, and triggers via Azure CLI in dependency order. Supports `--dry-run`.
- `domains/shared/pipelines/adf/triggers/tr_daily_medallion.json` — Daily 06:00 UTC trigger for medallion orchestration.
- `domains/shared/pipelines/adf/triggers/tr_hourly_ingest.json` — Hourly trigger for bronze ingestion.
- `docs/ADF_SETUP.md` — Full ADF setup guide (pipeline import, linked services, trigger management, CI/CD integration).
- `Makefile` — Added `deploy-adf` target.

#### Phase 2: Great Expectations Checkpoints
- `great_expectations/great_expectations.yml` — DataContext config with 3 ADLS Spark datasources (Bronze/Silver/Gold), filesystem stores.
- `great_expectations/checkpoints/bronze_customers_checkpoint.yml`
- `great_expectations/checkpoints/silver_sales_orders_checkpoint.yml`
- `great_expectations/checkpoints/gold_clv_checkpoint.yml`
- `governance/dataquality/ge_runner.py` — Added `_load_checkpoint_configs()` helper and `yaml` import; updated the GE-installed code path to report checkpoint availability.

#### Phase 3: Purview Lineage Integration
- `deploy/bicep/DLZ/modules/datafactory/datafactory.bicep` — Added `purviewAccountId` parameter and `purviewConfiguration` block (conditional).
- `scripts/purview/register_lineage.py` — Atlas REST API lineage registration script with 4 Process entities (ADF ingestion, Databricks B2S, dbt S2G, streaming). Includes `--schedule-scans` flag.
- `scripts/purview/bootstrap_catalog.py` — Added `create_scans()` function and `--schedule-scans` CLI flag for automated scan scheduling.
- `domains/shared/notebooks/databricks/config/openlineage.json` — OpenLineage transport config for Databricks-to-Purview lineage.

#### Phase 4: dbt Snapshots + Exposures
- `domains/shared/dbt/snapshots/snp_customers_history.sql` — SCD Type 2 snapshot on slv_customers (check strategy).
- `domains/shared/dbt/snapshots/snp_products_history.sql` — SCD Type 2 snapshot on slv_products.
- `domains/shared/dbt/snapshots/schema.yml` — Snapshot descriptions and tests.
- `domains/shared/dbt/models/gold/schema.yml` — Added 4 exposure definitions (executive revenue dashboard, customer 360, sales ops, finance aging).

#### Phase 5: Documentation
- `docs/DATABRICKS_GUIDE.md` — Workspace setup, cluster config, notebook orchestration patterns, dbt integration, Unity Catalog, troubleshooting.
- `docs/runbooks/security-incident.md` — Added Scenarios D-F (Cosmos DB, ADF tampering, Key Vault), evidence preservation checklist, communication templates, expanded contact table.
- `docs/TROUBLESHOOTING.md` — Expanded from 86 lines to 230+ lines. Added sections: ADF pipeline issues, Stream Analytics errors, Databricks issues, Purview scanning, GE checkpoints, Key Vault, Cosmos DB throttling, CI/CD workflow failures.

#### Phase 6: Tests + Verification
- `tests/purview/test_register_lineage.py` — 9 test cases covering entity construction, dry-run mode, deterministic GUIDs, full pipeline coverage.
- All 415 tests pass (1 skipped).
- Coverage: 85.17% (above 80% gate).
- mypy clean on all new/modified files.
- Bicep build clean on datafactory.bicep.

### Validation summary

- `pytest tests/ --cov --cov-fail-under=80` — 415 passed, 1 skipped, 85.17% coverage
- `mypy governance/dataquality/ge_runner.py scripts/purview/register_lineage.py` — no issues
- `az bicep build --file deploy/bicep/DLZ/modules/datafactory/datafactory.bicep` — clean

### Decisions & discoveries

- **GE checkpoint loading**: Added `yaml` import to `ge_runner.py` and a `_load_checkpoint_configs()` function that reads checkpoint YAMLs by suite name. The existing fallback path is unchanged — the checkpoints are informational in the CLI but functional in Databricks.
- **ADF Purview lineage**: Native ADF-to-Purview lineage uses `purviewConfiguration.purviewResourceId` on the factory resource. No additional API calls needed — ADF pushes lineage automatically on pipeline runs.
- **Snapshot strategy**: Used `check` strategy (not `timestamp`) for SCD Type 2 snapshots because customer/product records don't always have reliable `updated_at` columns from all source systems.

### Blockers / open questions

None. All 7 gaps are now filled. Platform is at 100% completion.
