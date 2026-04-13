# Development Log

Append-only record of notable work. Newest entries on top. Follows the
end-of-session protocol in `.claude/rules/session-end.md`.

---

## 2026-04-13 — Fill all remaining gaps (7/7 complete)

**Archon project:** `1bd59749-db0a-4009-82c7-f1a56d24a820`

Addressed all 7 identified gaps to bring the platform from 90% to 100%
completion. 16 new files created, 7 modified. All 415 tests pass,
85.17% coverage, mypy clean, Bicep clean.

### Summary of work

1. **ADF deployment automation** — `deploy-adf.sh` script, hourly and
   daily trigger JSONs, Makefile target, `ADF_SETUP.md` documentation.
2. **Great Expectations checkpoints** — `great_expectations/` directory
   with DataContext config and 3 checkpoint YAMLs (bronze/silver/gold).
   Updated `ge_runner.py` with checkpoint discovery.
3. **Purview lineage** — `purviewAccountId` parameter on ADF Bicep,
   `register_lineage.py` Atlas API script (4 process entities),
   `--schedule-scans` flag on bootstrap, OpenLineage config for Databricks.
4. **dbt snapshots + exposures** — 2 SCD Type 2 snapshot models
   (customers, products), 4 exposure definitions on Gold schema.yml.
5. **Documentation** — `DATABRICKS_GUIDE.md`, expanded security runbook
   (3 new scenarios + evidence checklist + comms templates), expanded
   `TROUBLESHOOTING.md` (86 -> 230+ lines, 8 new sections).
6. **Tests** — 9 new lineage tests, all 415 pass, coverage maintained.

### Files created
- `scripts/deploy/deploy-adf.sh`
- `domains/shared/pipelines/adf/triggers/tr_daily_medallion.json`
- `domains/shared/pipelines/adf/triggers/tr_hourly_ingest.json`
- `docs/ADF_SETUP.md`
- `great_expectations/great_expectations.yml`
- `great_expectations/checkpoints/bronze_customers_checkpoint.yml`
- `great_expectations/checkpoints/silver_sales_orders_checkpoint.yml`
- `great_expectations/checkpoints/gold_clv_checkpoint.yml`
- `great_expectations/expectations/.gitkeep`
- `scripts/purview/register_lineage.py`
- `domains/shared/notebooks/databricks/config/openlineage.json`
- `domains/shared/dbt/snapshots/snp_customers_history.sql`
- `domains/shared/dbt/snapshots/snp_products_history.sql`
- `domains/shared/dbt/snapshots/schema.yml`
- `docs/DATABRICKS_GUIDE.md`
- `tests/purview/test_register_lineage.py`

### Files modified
- `Makefile` (+deploy-adf target)
- `governance/dataquality/ge_runner.py` (+checkpoint loading)
- `deploy/bicep/DLZ/modules/datafactory/datafactory.bicep` (+purviewConfiguration)
- `scripts/purview/bootstrap_catalog.py` (+create_scans, --schedule-scans)
- `domains/shared/dbt/models/gold/schema.yml` (+exposures)
- `docs/runbooks/security-incident.md` (+3 scenarios, evidence, comms)
- `docs/TROUBLESHOOTING.md` (+8 sections, 150+ lines)

---

## 2026-04-10 — Audit remediation sweep + Archon todo batch 1 (complete)

**Archon project:** `1bd59749-db0a-4009-82c7-f1a56d24a820`

Landed 15 commits on `main` in a single session. Working tree is clean,
strict mypy passes (16 source files + 2 Function apps checked
separately), pytest green (61 tests, 93.10% coverage).

### Phase A — Triage + hygiene (5 commits)

Took the 26 in-progress modifications left over from the audit sweep
and committed them in logical groups alongside the audit-artifact
reorganisation and the `.claude/` tracking bootstrap.

- `84aa05b` repo hygiene — audit reports moved to `docs/audit/`, stray
  portal export deleted, Azure policy CSV references relocated to
  `governance/policies/reference/`, `.claude/SESSION_KNOWLEDGE.md` and
  friends bootstrapped, `.claude/settings.json` description fixed
  (had been copied from a different repo).
- `d998c6e` CI/CD safety — auto_commit off, timeouts on every job,
  environment approval gates on deploy.yml, Makefile early-exit,
  `.pre-commit-config.yaml`, `deploy/bicep/bicepconfig.json`,
  enriched pyproject ruff + mypy config.
- `e75d85e` docs — `docs/GETTING_STARTED.md`, `docs/TROUBLESHOOTING.md`,
  `tests/` scaffold.
- `6a8bff5` infra lockdown — public network access closed on Cosmos,
  AppInsights query, Purview, ALZ Log Analytics; Synapse admin
  username made unique; storage infrastructure encryption on; dbt
  models converted to incremental; SQL injection hardening in the
  Databricks notebook and run_dbt.py; ADF retry policies; Function
  error sanitisation; RBAC script wiring + narrowed scopes.
- `243d8a4` `.claude/` project rules + hooks committed; globals-synced
  dirs (agents/commands/skills/agent-memory) gitignored.

### Phase B — Archon todo backlog batch 1 (10 commits, 10 tasks)

All 10 todos visible on the first `find_tasks` page (task_order 45–80)
are now `done` in Archon:

1. `d0cb142` **Email regex consolidation** (`b9b4f126`). Created
   `governance/common/validation.py` as the canonical source. Wired
   `substitute_common_patterns` into the data-quality YAML loader;
   replaced the dbt inline in `slv_customers.sql` with the existing
   `flag_invalid_email` macro; added an `email_regex` var in
   `dbt_project.yml` mirroring the Python constant; 15 pytest cases.
2. `e0fcb4a` **Bicep API version refresh** (`57ed2e42`). Synapse
   (5 resource types) to 2021-06-01, Key Vault (both ALZ + DMLZ
   copies) to 2024-11-01 with softDeleteRetentionInDays 90 and
   explicit publicNetworkAccess Disabled, Container Registry (DMLZ
   + ALZ CRML) to 2023-07-01 GA with anonymousPullEnabled corrected
   to false. All modules `az bicep build`-clean.
3. `7e8174a` **Coverage threshold in CI** (`8b735520`). Replaced the
   broken `pytest --co` placeholder with a real `pytest --cov
   --cov-fail-under=80` run. Added `[tool.coverage.run|report|xml]`
   to pyproject, PR-comment via py-cov-action, coverage XML + HTML
   artifacts.
4. `c6e2d8f` **Rollback workflow + PITR** (`74b1d983`). Cosmos
   default backupPolicy flipped to Continuous30Days. Storage blob
   service gains deleteRetentionPolicy, versioning, changeFeed, and
   restorePolicy (6d window). New `.github/workflows/rollback.yml`
   with ROLLBACK confirmation + ref preflight + three
   landing-zone jobs + post-rollback verification. `deploy.yml`
   emits `deploy/<env>-<sha>-<run>` tags on success. New
   `docs/ROLLBACK.md` covering Bicep, ADF, dbt, Cosmos PITR, and
   storage recovery.
5. `5487848` **Structured JSON logging with trace IDs** (`7c36dbc6`).
   `governance/common/logging.py` wraps structlog with
   `configure_structlog` / `get_logger` / `bind_trace_context` /
   `extract_trace_id_from_headers`. Wired into the data-quality
   runner (run-scoped correlation_id) and both Function apps
   (traceparent header extraction + per-trigger binding).
   `docs/LOG_SCHEMA.md` documents the baseline fields, canonical
   events per service, and ready-to-run KQL queries. 14 test cases.
6. `7494e38` **Type hints + mypy strict** (`43511368`). Turned on
   `strict = true` globally. Added `governance/__init__.py` +
   `governance/dataquality/__init__.py` so the package resolves.
   Typed run_quality_checks, both function_app files, tests, and the
   Databricks notebook (the notebook remains excluded from mypy via
   overrides because spark/dbutils globals are unresolvable). New
   `make typecheck` target. Three-way mypy invocation in CI
   (default target + one per Function app) because the two
   `function_app.py` files collide on module path.
7. `a40dbb1` **Async Functions** (`02179890`). aiEnrichment function
   rewritten to use `azure.ai.textanalytics.aio` and
   `azure.ai.formrecognizer.aio` inside `async with` blocks.
   Dropped the synchronous `_get_ai_client` singletons; replaced
   with cheap capability probes for the health check. Every trigger
   is `async def`. eventProcessing function triggers are also
   `async def` for event-loop fairness, with the Cosmos output
   still flowing through the host-managed binding (docstring
   explains why).
8. `e0c1da9` **Great Expectations wiring** (`a211e42f`). New
   `governance/dataquality/ge_runner.py` with an in-memory
   fallback evaluator covering every expectation type in
   `quality-rules.yaml`. `DataQualityRunner.run_ge_checkpoints()`
   bridges the config to the runner and surfaces results as
   `QualityCheckResult` entries. New `--ge-only` CLI flag. 18
   parametrised tests covering every expectation type.
9. `3ed82e4` **Load test scaffold** (`a7a82cb2`). `tests/load/`
   directory with Locust + k6 HTTP-trigger harnesses, a dbt
   benchmark script with regression gate, and a README documenting
   the acceptance targets + baseline capture procedure. New
   `.github/workflows/load-tests.yml` (workflow_dispatch only) with
   four target options (locust, k6, dbt bench silver, dbt bench
   gold). `reports/` added to `.gitignore`.
10. `ac00139` **Multi-region DR strategy** (`3c27e17d`). New
    `storageSku` parameter on storage.bicep (defaults to the
    existing logic; callers can opt into Standard_RAGRS for
    critical workloads). New `secondaryLocation` parameter on
    cosmosdb.bicep (empty default; when set, builds a two-region
    `locations` array with failoverPriority 0 + 1). New
    `docs/DR.md` with the RPO/RTO tier matrix, primary/secondary
    region pairs, step-by-step failover + failback procedure, and
    a quarterly drill cadence.

### Discovered mid-session

- **Archon pagination hid half the backlog.** The `find_tasks`
  `per_page` default is 10, and the project has 20 todos. The
  second page (task_order 83–107) was invisible during the initial
  status briefing. Those 10 tasks remain `todo` — see
  `.claude/SESSION_KNOWLEDGE.md` for the list. Decision punted to
  the user.
- **great_expectations is already installed** in this dev env
  (pulled in by another tool), which meant the `ge_runner` tests
  caught a real behaviour difference between the "GE present but no
  sample data" skip path and the "GE absent" skip path.
- **Two Function apps + flat `function_app.py` module names** are
  incompatible with a single mypy invocation. Documented the
  workaround (three mypy calls) in the Makefile and CI.

### Validation summary at session close

- `mypy` (default target) — 16 files, no issues
- `mypy domains/sharedServices/aiEnrichment/functions/function_app.py` — no issues
- `mypy domains/sharedServices/eventProcessing/functions/function_app.py` — no issues
- `pytest tests/ --cov --cov-fail-under=80` — 61 passed, 93.10% coverage, gate met
- `az bicep build` — clean on every module touched (cosmos, storage, keyvault×2, containerregistry×2, synapse)

### Not touched this session (still todo)

See the 10 task backlog in `.claude/SESSION_KNOWLEDGE.md` — Unity
Catalog RBAC, ML approval gate, data-contract enforcement, GitHub
environment protection rules, Bronze/Silver surrogate-key refactor,
Silver flag-vs-filter semantics, Customer-Managed Keys, secret
rotation automation, extended audit log retention, and VNet/subnet
Bicep modules (flagged as "most critical infrastructure gap").
