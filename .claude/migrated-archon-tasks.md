# Migrated Archon v1 Tasks — CSA-in-a-Box (Both Projects)

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


> Frozen export of the Archon v1 task ledger for both CSA-in-a-Box
> projects, generated 2026-05-14 during the de-Archon-v1 migration.
>
> Archon v1 was archived 2026-04. The container at 192.168.2.100:8051
> is scheduled to shut down on 2026-05-28. This file is the durable
> historical record going forward.
>
> **Note on completeness:** Tasks were captured from a global Archon
> query (13 pages × 200 tasks = 2500 total across all projects). The CSA
> projects' completed/older tasks may exceed this cap and not appear here.
> Re-export via `mcp__archon__find_tasks(project_id=...)` if needed before
> container shutdown.

**Going forward use TodoWrite (in-session) + GitHub Issues on `fgarofalo56/csa-inabox` (cross-session).**

## CSA-in-a-Box: Cloud-Scale Analytics Platform
**Archon project ID**: `1bd59749-db0a-4009-82c7-f1a56d24a820`
**Tasks captured**: 53
**Status breakdown**: done:53

### status: done (53)

#### Write Azure Functions unit tests (aiEnrichment + eventProcessing)
_order: 112 . feature: Testing . assignee: Coding Agent . id: `ed33b927-225c-43af-a68e-f940d531fdd4`_

Both Azure Functions services (domains/sharedServices/aiEnrichment and domains/sharedServices/eventProcessing) have zero test coverage. Write unit tests covering: function triggers, input validation, error handling, service client mocking (Text Analytics, Form Recognizer, Event Hub, Cosmos DB), health endpoint responses, and edge cases. Use pytest with azure-functions-testability patterns. Target 80%+ coverage.

#### Add diagnostic settings to all remaining Azure resources (Cosmos, Synapse, ADX, etc.)
_order: 109 . feature: Monitoring . assignee: Coding Agent . id: `e3d9515d-a5e1-4194-9356-bd134995ded6`_

~80% of deployed resources lack diagnostic settings. Cosmos DB, Synapse, Stream Analytics, Event Hubs, Data Factory, Databricks — none send logs to Log Analytics. Create a shared diagnosticSettings.bicep module (already exists at deploy/bicep/shared/modules/diagnosticSettings.bicep) and wire it into every resource module in DLZ: cosmosdb.bicep, synapse.bicep, eventhubs.bicep, datafactory.bicep, databricks.bicep, streamanalytics.bicep, functions.bicep, machinelearning.bicep, dataexplorer.bicep. Pass logAnalyticsWorkspaceId and enable all log categories. Estimated: 4 hours.

#### Build VNet/subnet/NSG/private DNS Bicep modules (self-bootstrapping networking)
_order: 107 . feature: Infrastructure . assignee: Coding Agent . id: `be5429f6-3e3f-4888-8bcf-24db5cb9837e`_

The platform cannot self-bootstrap its own networking. VNet, subnet, NSG, UDR, and private DNS zone Bicep modules are missing. Build: (1) Hub VNet module with AzureFirewallSubnet, GatewaySubnet, management subnets. (2) Spoke VNet modules for DMLZ and DLZ with service-specific subnets. (3) NSG modules with least-privilege rules per subnet. (4) Private DNS zones for all PaaS services (privatelink.blob.core.windows.net, etc.). (5) VNet peering between hub and spokes. This is the most critical infrastructure gap.

#### Extend audit log retention beyond 90 days for compliance (1-7 years)
_order: 105 . feature: Compliance . assignee: Coding Agent . id: `ab7085b0-d8e0-44c7-928e-28c0ebbe4cb6`_

Azure Log Analytics default retention is 90 days, but compliance frameworks (SOC2, HIPAA, FedRAMP) require 1-7 years. Update logging.bicep to set retentionInDays to at least 365 and configure archival to Storage Account for long-term retention. Consider tiered retention: hot (90d Log Analytics) → cool (1y Storage) → archive (7y immutable Storage).

#### Build secret rotation automation (Azure Function App)
_order: 103 . feature: Security Hardening . assignee: Coding Agent . id: `2bce6682-ac09-49af-aec7-6c641faf61fc`_

Create an Azure Function that automatically rotates secrets stored in Key Vault on a schedule. Should handle: storage account keys, Cosmos DB keys, SQL passwords, service principal credentials. Use Event Grid subscription on Key Vault SecretNearExpiry events to trigger rotation. Include Bicep module for deployment and monitoring alerts for rotation failures.

#### Implement Customer-Managed Key (CMK) encryption for compliance
_order: 101 . feature: Compliance . assignee: Coding Agent . id: `e019c879-38dc-4c00-8a9e-8839849a0a91`_

Everything still uses Microsoft-managed keys. HIPAA/PCI-DSS compliance fails without CMK. Add Customer-Managed Key (CMK) parameters to Bicep templates: storage.bicep (encryption.keySource='Microsoft.Keyvault', keyVaultProperties), cosmosdb.bicep (keyVaultKeyUri parameter), synapse.bicep (encryptionConfig). Requires Key Vault with key pre-provisioned. Add conditional CMK enablement via parameter flag (default off for dev, required for prod). Estimated: 4 hours.

#### Uncomment Synapse private endpoints in DLZ synapse module
_order: 99 . feature: infrastructure . assignee: Coding Agent . id: `13bd6228-be2c-47cc-9e4c-31b37f643c6d`_

The existing synapse.bicep module at deploy/bicep/DLZ/modules/synapse/synapse.bicep has private endpoint blocks commented out. Uncomment them and wire to parameter toggles, following the same PE pattern used in the new databricks/datafactory modules.

#### Uncomment Purview private endpoints in DMLZ purview module
_order: 97 . feature: infrastructure . assignee: Coding Agent . id: `5ef38c55-c2a3-4580-9d8f-615b827ca6fe`_

deploy/bicep/DMLZ/modules/Purview/purview.bicep has private endpoint blocks commented out. Uncomment and wire to parameter toggles for portal and account sub-resources.

#### Create environment parameter files (params.dev.json) for all landing zones
_order: 95 . feature: infrastructure . assignee: Coding Agent . id: `49a74b47-eb3b-4b65-9f8f-44b0927471a5`_

Create complete params.dev.json files for DLZ, DMLZ, and ALZ based on the params.template.json files. Fill with dev environment values using small SKUs, auto-pause enabled, and <PLACEHOLDER> for secrets. Also create params.prod.json with production-appropriate settings.

#### Change Silver layer to flag (not filter) bad records to prevent silent data loss
_order: 95 . feature: Data Engineering . assignee: Coding Agent . id: `0ac384b5-de0d-4641-b715-a0f2c1da938e`_

Silver layer currently filters out bad records silently (WHERE conditions exclude nulls/invalids). This causes silent data loss — bad records disappear without a trace. Instead: (1) Add an is_valid boolean flag column, (2) Add validation_errors string column explaining why records failed, (3) Keep all records in Silver, (4) Filter to valid-only in Gold layer views. This preserves data lineage and enables quality monitoring.

#### Move surrogate key generation from Bronze to Silver layer
_order: 93 . feature: Data Engineering . assignee: Coding Agent . id: `310b5446-dad5-4543-b406-e8a855b47cc7`_

Bronze layer currently generates surrogate keys, violating medallion architecture principles. Bronze should be raw ingestion only (append-only, schema-on-read). Move surrogate key generation (md5 hashing, monotonically_increasing_id) to Silver layer transformations. Update affected dbt models and Databricks notebooks. Bronze models: brz_customers.sql, brz_orders.sql. Silver models: slv_customers.sql, slv_orders.sql.

#### Add GitHub Environment protection rules for production deployments
_order: 92 . feature: CI/CD . assignee: Coding Agent . id: `592588c2-4789-4266-b816-36fc6683a45c`_

Production deployments have no approval gates. Configure: (1) GitHub Environments for staging and production. (2) Required reviewers (minimum 1) for production environment. (3) Wait timer (optional, e.g., 5 min cooling period). (4) Branch protection requiring environment deployment status checks. (5) Deployment branch restriction (only main can deploy to production). Update deploy.yml workflow to reference these environments.

#### Wire cross-subscription outputs between ALZ, DMLZ, and DLZ mains
_order: 91 . feature: infrastructure . assignee: Coding Agent . id: `8642f90c-e68d-424a-aa4d-9c075bc07e51`_

Wire outputs from ALZ (hub VNet ID, firewall IP, Log Analytics workspace ID, private DNS zone IDs) as parameter inputs to DMLZ and DLZ mains. Use subscription-scoped existing resource references or parameter pass-through.

#### Wire managed identity RBAC assignments in DLZ main.bicep
_order: 89 . feature: infrastructure . assignee: Coding Agent . id: `9a87693f-f130-4301-91d7-500862f8cac8`_

After creating each service (Databricks, ADF, Functions, etc.), assign its managed identity the required roles on dependent services. E.g., ADF identity → Storage Blob Data Contributor on lake storage, Databricks identity → Key Vault Secrets User. Use the shared/modules/roleAssignment.bicep module.

#### Enforce data contracts programmatically (validate schema, SLAs, quality rules)
_order: 87 . feature: Data Engineering . assignee: Coding Agent . id: `ec22583d-20cb-4cc1-ae8f-b001b140c7b1`_

Data contracts in domains/*/data-products/*/contract.yaml are defined but never enforced programmatically. Implement: (1) A Python validator that reads contract YAML and validates incoming data against declared schema, SLAs, and quality rules. (2) Integration with dbt tests — auto-generate dbt schema tests from contract definitions. (3) CI check that validates contracts are complete and internally consistent. (4) Runtime enforcement in the ingestion pipeline that rejects data violating contracts.

#### Add ML model approval gate and remove synthetic data fallback
_order: 84 . feature: Data Engineering . assignee: Coding Agent . id: `b210c0cf-b8aa-4937-bcc4-1ef915e43746`_

The ML pipeline in domains/shared/notebooks/databricks has two issues: (1) No model approval gate — models go straight to production without human review or automated quality checks. Add an MLflow model registry stage gate (Staging → Production requires approval + metric thresholds). (2) Synthetic data fallback masks real problems — if training data is unavailable, the pipeline generates fake data and trains on it. Remove synthetic fallback; fail loudly instead so data pipeline issues get fixed.

#### Uncomment and implement Unity Catalog RBAC permissions
_order: 83 . feature: Security Hardening . assignee: Coding Agent . id: `d55952f9-d15e-4387-9a49-4d362bcffec4`_

Unity Catalog RBAC setup in domains/shared/notebooks/databricks/unity_catalog/setup_catalog.py is commented out. The code exists but is never executed, meaning catalog/schema permissions are not enforced. Uncomment and implement: (1) GRANT/REVOKE statements for catalog-level permissions. (2) Schema-level access control per domain (e.g., sales domain gets USE SCHEMA on sales schemas only). (3) Table-level row/column security where needed. (4) Integration with AAD groups for identity mapping. (5) Audit logging of permission changes. Test with a dry-run mode first.

#### Implement deployment rollback procedure and workflow
_order: 80 . feature: CI/CD . assignee: Coding Agent . id: `74b1d983-f23c-42e9-8990-c9cdf4f9c17d`_

No rollback procedure exists for failed deployments. Implement: (1) Document manual rollback steps per service (Bicep revert, ADF pipeline restore, dbt model rollback). (2) Create rollback.yml GitHub Actions workflow that can target specific services. (3) Add deployment tagging (git tag on successful deploy) for easy revert points. (4) Cosmos DB and storage account point-in-time restore configuration. (5) Test rollback procedure quarterly and document in Deployment guide.

#### Wire up Great Expectations integration for data quality validation
_order: 79 . feature: Data Engineering . assignee: Coding Agent . id: `a211e42f-2aae-4e0d-aad4-398e5a720434`_

run_quality_checks.py references Great Expectations integration but it's never wired up. Implement: (1) GE checkpoint configuration for Bronze/Silver/Gold layers, (2) Expectation suites for critical tables (null checks, uniqueness, referential integrity, value ranges), (3) Integration in DataQualityRunner.run_ge_checkpoints() method, (4) GE data docs generation for quality reporting dashboard. Use GE v0.18+ with Databricks/Spark datasource.

#### Implement multi-region disaster recovery strategy
_order: 77 . feature: Infrastructure . assignee: Coding Agent . id: `3c27e17d-1e7a-4958-a2b1-8bd20cc765f9`_

No DR strategy exists. Implement: (1) Geo-redundant storage (RA-GRS) for critical data. (2) Cosmos DB multi-region writes configuration. (3) Cross-region Databricks workspace failover documentation. (4) ADF pipeline region failover with linked service reconfiguration. (5) RPO/RTO targets documented per service tier. (6) DR runbook with step-by-step failover/failback procedures. (7) Automated DR testing pipeline (quarterly chaos engineering).

#### Create load/performance tests for data pipelines and APIs
_order: 76 . feature: Testing . assignee: Coding Agent . id: `a7a82cb2-216d-4502-8e3c-99ace730a3ff`_

No performance testing exists. Create: (1) Locust or k6 load tests for Azure Function endpoints, (2) dbt model performance benchmarks measuring query execution time and data volume handling, (3) ADF pipeline throughput tests with realistic data volumes, (4) Databricks notebook execution time baselines. Store results for regression detection. Add to CI as optional stage.

#### Add Bicep what-if PR comment workflow
_order: 74 . feature: ci-cd . assignee: Coding Agent . id: `22372896-9b87-477f-b6f5-fbfb259a787f`_

Create .github/workflows/bicep-whatif.yml that runs az deployment sub what-if on PR and posts the infrastructure change summary as a PR comment. Requires OIDC authentication to Azure.

#### Implement structured JSON logging with trace IDs across all services
_order: 69 . feature: Monitoring . assignee: Coding Agent . id: `7c36dbc6-7118-47a4-9eed-99ee261a5cca`_

Current logging is unstructured print/logger.info with no correlation. Implement: (1) Replace all logging with structlog (structured JSON output). (2) Add trace_id and correlation_id to all log entries for request tracing across services. (3) Configure Azure Functions to output structured JSON logs. (4) Add request/response logging middleware. (5) Create log schema documentation. (6) Configure Log Analytics workspace to parse structured fields. This enables effective debugging and monitoring across the distributed platform.

#### Add data quality framework (Great Expectations or dbt tests)
_order: 68 . feature: governance . assignee: Coding Agent . id: `a5eae5f2-91c7-417f-b6fb-06735a0ebb76`_

Create governance/dataquality/ with comprehensive data quality rules. Options: Great Expectations config, or extended dbt tests. Wire to Azure Monitor alerts for quality failures. Include freshness checks, completeness, uniqueness, referential integrity.

#### Add code coverage threshold enforcement to CI pipeline
_order: 67 . feature: CI/CD . assignee: Coding Agent . id: `8b735520-0fdb-4dd4-9d9d-8f87e65fee2e`_

CI runs tests but has no code coverage threshold. Add: (1) pytest-cov to test workflow with --cov flag and --cov-fail-under=80. (2) Coverage report upload as GitHub Actions artifact. (3) PR comment with coverage diff (using a coverage action like py-cov-action/python-coverage-comment-action). (4) Branch-specific thresholds (main: 80%, feature branches: no regression). (5) .coveragerc configuration excluding test files and __init__.py from coverage calculation.

#### Convert Azure Functions to async patterns for better throughput
_order: 66 . feature: Performance . assignee: Coding Agent . id: `02179890-ac76-44a7-9a8e-4affb172793a`_

Azure Functions use synchronous patterns throughout, blocking the event loop during I/O operations (Azure AI calls, Cosmos DB writes, Event Hub sends). Convert: (1) All HTTP-triggered functions to async def. (2) Replace synchronous SDK clients with async equivalents (azure.ai.textanalytics.aio, azure.cosmos.aio, azure.eventhub.aio). (3) Use aiohttp for any HTTP calls. (4) Add proper async context manager patterns for client lifecycle. This improves throughput under concurrent load significantly.

#### Create Azure Monitor Workbook templates
_order: 62 . feature: observability . assignee: Coding Agent . id: `72d93ffc-bff2-4474-a166-7a2e2d13377e`_

Create deploy/bicep/shared/modules/workbooks/ with Bicep definitions for: data platform health workbook, pipeline performance workbook, data freshness SLA workbook. Use KQL queries from scripts/monitor/kql/platform_queries.kql.

#### Update remaining Bicep API versions (Synapse, Key Vault, Container Registry)
_order: 61 . feature: Infrastructure . assignee: Coding Agent . id: `57ed2e42-45a5-4833-9a8e-176f23e07649`_

Several Bicep resources use outdated API versions that miss security features and bug fixes: Synapse (2021-03-01 → 2023-11-01-preview or latest GA), Key Vault (2021-04-01 → 2023-07-01), Container Registry (2020-11-01 → 2023-11-01-preview). Update all API versions, test with what-if to ensure no breaking changes, and verify new properties are available (e.g., newer Key Vault API supports RBAC authorization mode).

#### Configure log routing and retention in ALZ logging module
_order: 56 . feature: observability . assignee: Coding Agent . id: `7d61227e-3f8b-4a9b-bfe3-dee2c4cd18f3`_

Update ALZ logging module to configure centralized log routing from all services → Log Analytics. Set retention policies: 30d hot, 90d warm, 365d archive. Add Storage Account for long-term archive.

#### Consolidate 3 duplicate email validation regexes into single shared utility
_order: 51 . feature: Code Quality . assignee: Coding Agent . id: `b9b4f126-32b7-4f01-a781-ce244f06b512`_

There are 3 different email validation regexes scattered across the codebase (dbt models and Python). Consolidate into a single reusable utility: (1) Create a shared dbt macro for email validation, (2) Create a Python utility function for email validation, (3) Replace all inline regex patterns with calls to the shared utilities. Ensures consistent validation rules and single point of maintenance.

#### Add Key Vault integration patterns and secret rotation
_order: 50 . feature: governance . assignee: Coding Agent . id: `8054ce4c-939f-441b-b68c-8b09e3657fb4`_

Create governance/keyvault/ with scripts for: setting access policies for managed identities, rotating connection string secrets, wiring ADF linked services to Key Vault, creating Databricks secret scopes backed by Key Vault.

#### Add type hints to all Python files and enable mypy strict mode
_order: 45 . feature: Code Quality . assignee: Coding Agent . id: `43511368-9e25-4b4b-87df-1435ce220465`_

Most Python files have no type hints, making IDE support and static analysis ineffective. Add type hints to: (1) All function signatures (parameters and return types). (2) Class attributes and instance variables. (3) Key variables where types are non-obvious. Priority files: run_quality_checks.py, function_app.py (both services), delta_lake_optimization.py, run_dbt.py, all utility modules. Run mypy in strict mode after adding hints. Update pyproject.toml mypy config.

#### P5-POLISH: Consolidate shared modules, externalize business rules, fix refs
_order: 41 . feature: Phase-5-Polish . assignee: Coding Agent . id: `05be8e49-e1c4-4395-a3ba-efc50e612627`_

Consolidate duplicated patterns and externalize business rules:

1. **Private endpoint modules** — deploy/bicep/shared/modules/privateEndpoint.bicep AND deploy/bicep/DLZ/modules/network/privatelink.bicep exist with different interfaces. Consolidate or refactor DLZ modules to use shared module.

2. **Shared Bicep modules underutilized** — shared/ has roleAssignment.bicep, cmkIdentity.bicep, networking modules, but DLZ/DMLZ implement inline. Progressively refactor.

3. **DMLZ missing cross-subscription outputs** — No Purview account ID or managed identity principal ID outputs. DLZ needs these for lineage wiring.

4. **dbt business rule externalization:**
   - gld_customer_lifetime_value: segment thresholds (90/365 days), value tiers (10000/5000/1000) → dbt vars
   - dim_products: price_tier boundaries (100/50/25) → dbt vars
   - gld_aging_report: loss rates (0.01/0.05/0.10/0.25) → dbt vars
   - dim_customers: US state-to-region mapping → seed table

5. **Cross-domain dependency formal...

#### P5-POLISH: Standardize naming conventions, cleanup orphans, add CHANGELOG
_order: 40 . feature: Phase-5-Polish . assignee: Coding Agent . id: `f45c3450-c0c1-4b5f-a0ed-b329f845fd63`_

Naming and organizational cleanup:

1. **PowerShell scripts** — Standardize ALL to kebab-case:
   - Create_WHL.ps1 → create-whl.ps1
   - Diagnostic_Settings_Policy.ps1 → diagnostic-settings-policy.ps1
   - EnvironmentVariables.ps1 → environment-variables.ps1
   - "New SP with Cert.ps1" → new-service-principal-cert.ps1
   - installSHIRGateway.ps1 → install-shir-gateway.ps1
   - Fix typos: "Managment" → Management, "Helsper" → Helper
   - Remove duplicates: CosmosDB.ps1 vs cosmosDB.ps1

2. **Directories** — Standardize to lowercase/kebab-case:
   - scripts/Azure IPs/ → scripts/azure-ips/
   - scripts/PowerShell/ → scripts/powershell/
   - scripts/ServicePrincipal/ → scripts/service-principal/
   - scripts/Synapse-DEP/ → scripts/synapse-dep/
   - scripts/SAP/ → scripts/sap/

3. **Orphaned directories** — Document purpose or remove:
   - scripts/SAP/ (1 JSON file)
   - scripts/python/notebooks/ (empty)

4. **Deprecated ARM** — Add deploy/arm/DEPRECATED.md with migration guide and remova...

#### P4-QUAL: Python code quality — type hints, docstrings, magic numbers, imports
_order: 33 . feature: Phase-4-Quality . assignee: Coding Agent . id: `5c7417a2-ce70-4475-ad05-7561186af2e2`_

Python code quality improvements:

1. **Missing type hints** — scripts/purview/bootstrap_catalog.py returns `Any` instead of specific types despite mypy strict.
2. **Missing __all__** — governance/__init__.py and sub-packages have empty __init__.py without __all__ declarations.
3. **Missing docstrings** — governance/common/validation.py public functions lack comprehensive docstrings.
4. **Unused imports** — scripts/seed/load_sample_data.py imports `glob` and `os` but doesn't use them.
5. **Magic numbers** — aiEnrichment function_app.py has hardcoded 5120 text limit and 125000 char limit. Externalize to env vars.
6. **Inconsistent string formatting** — scripts/purview/bootstrap_catalog.py mixes f-strings and concatenation.
7. **Missing error recovery docs** — secretRotation function_app.py has no documentation on manual recovery procedures.
8. **Event ID collisions** — eventProcessing function_app.py uses datetime.now().isoformat() for ID generation — could collide under high through...

#### P4-QUAL: CI/CD enhancements — caching, matrix, deduplication, test artifacts
_order: 32 . feature: Phase-4-Quality . assignee: Coding Agent . id: `c3b2f260-e6c5-4d20-a5e2-a70e8b98c7ce`_

CI/CD enhancements and testing improvements:

1. **dbt pip caching** — test.yml dbt-compile and dbt-integration jobs don't cache pip. Add `cache: 'pip'` to setup-python steps.
2. **dbt packages caching** — Cache dbt_packages/ keyed on packages.yml hash.
3. **Python version matrix** — pyproject.toml says `>=3.10` but tests only run on 3.11. Add matrix: [3.10, 3.11, 3.12].
4. **Deduplicate Python linting** — ruff check runs in both validate.yml AND test.yml (possibly different versions). Consolidate.
5. **dbt baselines** — load-tests.yml references missing tests/load/baselines/ directory. Create baseline files or remove references.
6. **Makefile test-dbt** — Only tests shared domain. CI tests [shared, finance, inventory, sales]. Add per-domain targets or loop.
7. **dbt integration artifacts** — Upload target/run_results.json and manifest.json on failure for debugging.
8. **test_data_quality.py** — Uses sys.path.insert hack instead of `governance.dataquality.run_quality_checks` import....

#### P4-QUAL: Fix Bicep typos, logic bugs, API versions, and consistency
_order: 31 . feature: Phase-4-Quality . assignee: Coding Agent . id: `3efa812d-4fb8-47dc-a0da-5354d1471361`_

Bicep consistency and bug fixes:

1. **Typos to fix:**
   - ALZ main.bicep line 226: `privatelink.postgres.database.azure.co` → `.com` (missing 'm')
   - ALZ main.bicep/params: `deployModules.requirments` → `requirements` (10+ references)
   - DMLZ main.bicep: "Moddules" → "Modules" in comments
   - DLZ main.bicep line 246: Uses `varStorageTags` instead of `varExternalStorageTags`
   - externalstorageMain.bicep line 16: `@description('Private endpoint subnet ID')` on tags param

2. **Logic bugs:**
   - privatelink.bicep line 50: `serviceSubResource == serviceSubResource` always true — remove ternary
   - Purview purview.bicep line 135: `configKafka ? 'Disabled' : 'Enabled'` — likely inverted

3. **Consistency:**
   - Location @allowed lists differ across ALZ/DLZ/DMLZ — standardize
   - CosmosDB enableAutomaticFailover: prod uses string "Enabled", dev uses bool false — pick one
   - Add missing `@description` decorators to ALZ parameters
   - DMLZ Purview env param not wired from par...

#### P4-QUAL: Standardize dbt naming conventions and remove dead macros
_order: 30 . feature: Phase-4-Quality . assignee: Coding Agent . id: `e8424f5a-decc-4197-8dc2-4a03af5b68bd`_

Standardize dbt naming and remove dead code:

1. **Incremental watermark columns** — 3 different names: `_ingested_at` (most models), `_dbt_loaded_at` (some), `_metadata.file_modification_time` (brz_customers). Standardize to `_ingested_at` everywhere. Use the `incremental_filter` macro (defined but never used).

2. **Bronze unique keys** — brz_products uses `product_id`, others use `_surrogate_key`. Standardize to `_surrogate_key`.

3. **Silver surrogate keys** — slv_sales_orders uses `order_id` directly, others use `*_sk`. Add `order_sk`.

4. **Metadata column names** — Inventory uses `_dbt_invocation_id`, all others use `_dbt_run_id`. Standardize.

5. **Dead macros** — Remove or adopt:
   - `incremental_filter.sql` — defined but never used (adopt it!)
   - `scd_type2.sql` — 119 lines, never referenced
   - `tenant_filter.sql` — never referenced

6. **Template fix** — templates/data-product/scaffold/dbt/dbt_project.yml uses `profile: csa_databricks` but all domains use `csa_analyt...

#### P3-SEC: Add Dependabot, CodeQL SAST, scheduled CI, hygiene enforcement
_order: 21 . feature: Phase-3-Security . assignee: Coding Agent . id: `f64ba3eb-6818-43d0-94b1-46a4051699e6`_

Add Dependabot + CodeQL + scheduled CI:

1. **Dependabot** — Create .github/dependabot.yml with:
   - pip ecosystem (weekly, /pyproject.toml)
   - github-actions ecosystem (weekly, /.github/workflows/)
   - Groups for Azure SDK updates

2. **CodeQL** — Create .github/workflows/codeql.yml:
   - Analyze Python code for injection, deserialization vulnerabilities
   - Run on PR + weekly schedule
   - Beyond what Checkov/Bandit catch

3. **Scheduled CI** — Add `schedule: cron: '37 3 * * 1'` (weekly Monday 3:37am) to test.yml to catch dependency breakage early

4. **Validate.yml hygiene job** — Currently never fails (no `exit 1`). Make it fail when committed venvs or large files are detected.

5. **Pre-commit ruff version** — .pre-commit-config.yaml has rev: v0.15.10 which may conflict with pyproject.toml range `ruff>=0.3.0,<1.0.0`. Verify and align.

#### P3-SEC: NSG egress rules, CMK enforcement, PII redaction, data classification
_order: 20 . feature: Phase-3-Security . assignee: Coding Agent . id: `d79a44c5-4d89-4086-b919-53dd3ebd0f2c`_

NSG rules and compliance gaps:

1. **NSG egress rules missing** (deploy/bicep/shared/modules/networking/nsgRules.bicep) — All 4 subnet rule sets (data, compute, management, integration) only define inbound rules. No outbound restrictions = compromised workloads can exfiltrate anywhere. Add outbound deny-all + explicit allows for AzureCloud, AzureActiveDirectory, AzureMonitor service tags.

2. **CMK defaults to off** across ALL data services (storage.bicep, cosmosdb.bicep, synapse.bicep, eventhubs.bicep, databricks.bicep — all have `parEnableCmk` defaulting to false). For HIPAA/SOC2/FedRAMP, add CI validation that checks params.prod.json for parEnableCmk: true, or add Azure Policy to deny without CMK.

3. **PII redaction incomplete** (aiEnrichment/function_app.py lines 162-170) — Redacts to `f"{e.text[:3]}***"` but 3 chars may be the entire PII value for short values. Original text is not redacted in output blob. Use `recognize_pii_entities` redacted_text property instead.

4. **Quar...

#### P2-HIGH: Security hardening — SHIR VM, OpenLineage auth, public access defaults
_order: 15 . feature: Phase-2-High . assignee: Coding Agent . id: `46568d11-ba63-446d-a30b-73e8b3e6d3e0`_

Security-critical SHIR VM and OpenLineage issues:

1. **SHIR VM** (deploy/bicep/DLZ/modules/vms/selfHostedIntegrationRuntime.bicep):
   - Password auth enabled (no disablePasswordAuthentication)
   - Auth key passed inline in commandToExecute (visible in process listings)
   - No disk encryption (encryptionAtHost: true missing)
   - ExecutionPolicy RemoteSigned (should be AllSigned)

2. **OpenLineage** (domains/shared/notebooks/databricks/config/openlineage.json):
   - Uses `"type": "api_key"` with `PURVIEW_API_KEY` placeholder — deviates from managed identity pattern used everywhere else
   - Replace with `"type": "oauth"` using managed identity

3. **Cosmos DB** (DLZ/modules/cosmos/cosmosdb.bicep line 48):
   - `disableKeyBasedMetadataWriteAccess` defaults to false — should be true for defense-in-depth

4. **Function App / Web App** (DLZ functions.bicep line 105, DMLZ function.bicep line 120, webApp.bicep line 116):
   - Public network access auto-enabled when no private endpoints...

#### P2-HIGH: Fix CI/CD workflow bugs (secret names, timeouts, error handling)
_order: 14 . feature: Phase-2-High . assignee: Coding Agent . id: `b84a94a9-2b35-4ede-8bd9-3fbf15c26639`_

CI/CD workflows have bugs that cause silent failures:

1. **bicep-whatif.yml** (lines 98, 104) — Matrix uses `DMLZ_SUBSCRIPTION_ID` and `DLZ_SUBSCRIPTION_ID` but all other workflows use `AZURE_DMLZ_SUBSCRIPTION_ID` / `AZURE_DLZ_SUBSCRIPTION_ID`. The `${{ secrets[matrix.subscription_secret] }}` resolves to empty string, causing silent what-if failures.
2. **test.yml** (lines 122-123) — `dbt compile || echo "needs connection"` swallows real YAML/ref errors. Restructure to fail visibly when secrets ARE present.
3. **validate.yml** — All 5 jobs missing `timeout-minutes`. Stuck scan = 6 hours of runner minutes.
4. **validate.yml** PowerShell lint — Only calls Format-Table, never exits non-zero. Always passes regardless of errors.
5. **deploy.yml / rollback.yml** — `$MODE` variable unquoted in az deployment commands. Quote or use if/else block.

Fix: Add `AZURE_` prefix to what-if secret names. Restructure dbt compile error handling. Add timeout-minutes: 15 to all validate jobs. Add exit-...

#### P2-HIGH: Fix storage/monitoring gaps in DLZ Bicep modules
_order: 13 . feature: Phase-2-High . assignee: Coding Agent . id: `f9828f5c-a73f-4d30-a9f0-47ceba90c9c8`_

Multiple Bicep modules have gaps that prevent proper security/monitoring:

1. **lakezones.bicep** (DLZ/modules/storage/) — calls storage.bicep 3x but NEVER passes logAnalyticsWorkspaceId, enableResourceLock, storageSku, or CMK params. Lake storage gets no diagnostics, locks, or CMK.
2. **storage.bicep** (DLZ/modules/storage/) — `storageFileSystemIds` output references containers via resourceId() but no containers are actually created in the module.
3. **main.bicep** (DLZ/) — CosmosDB module call doesn't pass logAnalyticsWorkspaceId even though cosmosdb.bicep accepts it (line 112). Cosmos has no diagnostics.
4. **externalstorage.bicep** — Missing diagnostic settings entirely.
5. **appinsights.bicep** — Missing connectionString output needed by Functions module.

Fix: Thread logAnalyticsWorkspaceId, enableResourceLock, and CMK params through lakezones.bicep. Add container resource blocks to storage.bicep. Pass logAnalyticsWorkspaceId to CosmosDB. Add diagnostics to external storage. A...

#### P2-HIGH: Add source freshness checks to inventory and sales domains
_order: 12 . feature: Phase-2-High . assignee: Coding Agent . id: `bff4c9ce-8048-4e10-89e7-fa8853a17d82`_

Inventory and Sales domain sources have no freshness monitoring:

1. **domains/inventory/dbt/models/bronze/sources.yml** — `raw_inventory` source missing `loaded_at_field` and `freshness` config
2. **domains/sales/dbt/models/bronze/sources.yml** — `raw_sales` source missing `loaded_at_field` and `freshness` config

Both shared (raw_data) and finance (raw_finance) sources correctly have freshness checks. Without these, `dbt source freshness` skips inventory and sales entirely — blind spot for stale data.

Fix: Add `loaded_at_field: _ingested_at` (or equivalent) and `freshness: { warn_after: { count: 24, period: hour }, error_after: { count: 48, period: hour } }` to both sources, matching the pattern in shared/finance.

#### P2-HIGH: Fix dbt schema test failures and add missing grain tests
_order: 11 . feature: Phase-2-High . assignee: Coding Agent . id: `3a0bba69-1102-43fe-be44-647364967b20`_

Multiple schema test failures and missing grain tests:

1. **gld_aging_report** schema.yml tests `invoice_sk` (line 9-12) but model outputs `invoice_id` — test will fail with "column not found". Change to `invoice_id`.
2. **gld_revenue_reconciliation** contract specifies `reconciliation_key` as PK but SQL doesn't generate it. Add surrogate key: `dbt_utils.generate_surrogate_key(['order_id', 'reconciliation_status'])`. Add unique/not_null tests.
3. **gld_sales_metrics** — no uniqueness test for composite key `(order_date, sales_region, sales_channel)`. Add `dbt_utils.unique_combination_of_columns`.
4. **slv_customers** — `customer_id` missing `not_null` test (inconsistent with slv_orders which has it).
5. **slv_payments** — `invoice_id` has no `relationships` test to `slv_invoices.invoice_id`.
6. **gld_aging_report** — no `unique` test on `invoice_id` PK.
7. **Duplicate schema files** — domains/shared/dbt/models/silver/ has BOTH schema_contract_generated.yml AND schema.yml testing sl...

#### P2-HIGH: Fix broken dbt incremental strategies and validation patterns
_order: 10 . feature: Phase-2-High . assignee: Coding Agent . id: `237bd628-130d-4c77-91b3-ab9bcec1c57a`_

Multiple dbt models have broken or missing incremental strategies:

1. **gld_daily_order_metrics** — configured as incremental but has NO `{% if is_incremental() %}` block. Full table scan every run.
2. **gld_customer_lifetime_value** — incremental filter applied AFTER aggregation (lines 91-97), so upstream CTEs still scan everything. Move filter inside the `orders` CTE.
3. **gld_sales_metrics** — filters on individual flags (`not _is_negative_price and not _is_future_date`) instead of canonical `WHERE is_valid = TRUE`. Won't pick up new validation rules.

Fix: Add proper incremental filters to gld_daily_order_metrics. Move filter inside CTE for gld_customer_lifetime_value. Change gld_sales_metrics to `WHERE is_valid = TRUE`.

#### P1-CRIT: Add Azure SDK retry logic to secret rotation and Function Apps
_order: 6 . feature: Phase-1-Critical . assignee: Coding Agent . id: `4871b521-e8b1-4eac-ab2a-b990dfc71092`_

Critical reliability gaps in Azure Function apps:

1. **Secret Rotation** (domains/sharedServices/secretRotation/functions/function_app.py):
   - Lines 167-173: storage_client.storage_accounts.regenerate_key() has no retry
   - Lines 225-231: cosmos_client.database_accounts.begin_regenerate_key() has no retry
   - Lines 372-386, 448-476: Broad `except Exception` doesn't distinguish retriable vs permanent errors

2. **AI Enrichment** (domains/sharedServices/aiEnrichment/functions/function_app.py):
   - Lines 173-175, 229-231: Azure AI calls use generic `except Exception` without retry
   - Lines 327-328: Reads entire blob into memory (no streaming for large files)
   - Lines 114-118: Clients created per invocation instead of connection pooling

3. **Event Processing** (domains/sharedServices/eventProcessing/functions/function_app.py):
   - Lines 134-149: No input validation/schema check on incoming events

Fix: Add `azure.core.pipeline.policies.RetryPolicy` or `tenacity` retry decora...

#### P1-CRIT: Remove committed binaries, venvs, and emulator files from Git
_order: 5 . feature: Phase-1-Critical . assignee: Coding Agent . id: `703623e9-a07b-4518-af17-3bbed75cc9dc`_

Multiple large/sensitive files committed despite .gitignore rules:

1. **ArcGIS JARs (600+ MB)** — domains/spark/ArcGIS_GeoAnalyticsEngine/ — Move to Git LFS or remove
2. **Jupyter notebooks with output (80+ MB)** — scripts/monitor/SynapseLogging.ipynb (80MB), StorageLogging.ipynb (4.8MB) — Strip with nbstripout
3. **Azurite emulator files** — __azurite_db_blob__.json, __azurite_db_blob_extent__.json, __blobstorage__/ — leaks local filesystem paths
4. **Virtual environments** — domains/sharedServices/aiEnrichment/functions/.venv/, tools/dbt/dbt-env/ — thousands of tracked files, supply chain risk
5. **node_modules** — deploy/bicep/DMLZ/node_modules/ — not needed for Bicep
6. **.coverage** — .coverage binary file (122KB)

Commands:
```bash
git rm --cached __azurite_db_blob*.json
git rm -r --cached __blobstorage__/
git rm -r --cached domains/sharedServices/aiEnrichment/functions/.venv/
git rm -r --cached tools/dbt/dbt-env/
git rm -r --cached deploy/bicep/DMLZ/node_modules/
git rm --ca...

#### P1-CRIT: Fix DMLZ governance property name mismatches (deploy crash)
_order: 4 . feature: Phase-1-Critical . assignee: Coding Agent . id: `f14e1403-df58-4ba8-84d1-38a3d9e4b303`_

DMLZ Bicep modules will crash at deploy time due to parameter mismatches:

1. **Governance module** (deploy/bicep/DMLZ/modules/governance/governance.bicep lines 48-65) accesses `parGovernance.purviewAcountName` (typo: "Acount") but params.dev.json uses `parPurviewName`. Also mismatched: purviewSku, purviewPublicNetworkAccess, purviewLocation, purviewTenantEndpointState, purviewKafkaConfig — params file uses different property names with `par` prefix.
2. **Missing params** — main.bicep line 99 accesses `parGovernance.rgTags` and line 64 requires `privateDNSZones` — neither provided in params.dev.json.
3. **DMLZ Databricks** missing `identity` block (modules/Databricks/databricks.bicep lines 49-75) but output at line 155 tries to access `databricksWorkspace.identity.principalId` — will fail.

Fix: Align all property names between Bicep modules and params files. Fix "Acount" typo. Add missing rgTags and privateDNSZones to params. Add `identity: { type: 'SystemAssigned' }` to DMLZ Datab...

#### P1-CRIT: Fix DLZ external storage missing deployment guard
_order: 3 . feature: Phase-1-Critical . assignee: Coding Agent . id: `7ba54330-e15c-4bbc-a345-6dcef64ef3fc`_

deploy/bicep/DLZ/main.bicep lines 253-267: The `externalStorageServices` module is NOT wrapped in `if (bool(deployModules.externalStorage))`. The resource group IS conditional (line 239), but the module itself always deploys. If externalStorage=false, deploy crashes because the RG won't exist.

Fix: Add `= if (bool(deployModules.externalStorage))` to the externalStorageServices module declaration.

#### P1-CRIT: Remove hardcoded subscription ID, IP, and PII from ALZ params
_order: 2 . feature: Phase-1-Critical . assignee: Coding Agent . id: `a96b53a0-a3f7-4ac8-aa4e-cc6d9049105c`_

Three hardcoded values committed to source control in ALZ:

1. **Subscription ID** — `deploy/bicep/LandingZone - ALZ/params.dev.json` line 15 (real sub ID `a60a2fdd-c133-4845-9beb-31f470bf3ef5` repeated at lines 375, 603). Replace with `<ALZ_SUBSCRIPTION_ID>` placeholder.
2. **IP Address** — `deploy/bicep/LandingZone - ALZ/main.bicep` lines 551-556 has `98.204.179.172` hardcoded in storage ipRules. Parameterize as `parAllowedIpAddresses`.
3. **Contact info** — `main.bicep` lines 128-129 has `PrimaryContact: 'frgarofa'` and `CostCenter: 'FFL ATU - exp12345'` hardcoded in tags. Add parameters matching DLZ/DMLZ pattern.

Also add Key Vault reference for SQL admin password in `deploy/bicep/DLZ/params.prod.json` line 128 instead of plaintext placeholder.

#### Fix CRITICAL dbt data layer bugs across all domains
_order: 1 . feature: Data Engineering . assignee: Claude . id: `3aa9cc91-cd92-4c99-b227-a42728ae7328`_

Fix 6 critical data layer bugs identified in dbt models:

1. gld_inventory_turnover — fictitious demand data (CROSS JOIN issue)
2. gld_aging_report — bucket values don't match schema tests  
3. brz_orders — missing _surrogate_key column
4. gld_revenue_reconciliation — customer_id lost on INVOICE_ONLY rows
5. gld_monthly_revenue — wrong unique_key for grain
6. fact_orders — joins Silver instead of Gold dimension

These bugs affect data accuracy, schema test compliance, and incremental model integrity. Each fix requires reading the specific SQL file and corresponding schema.yml to understand expected vs actual outputs.

#### P1-CRIT: Fix gld_inventory_turnover SQL syntax error and missing column
_order: 1 . feature: Phase-1-Critical . assignee: Coding Agent . id: `d046e739-a31e-4bb5-9a4a-29beb12c8e0e`_

TWO CRITICAL bugs in domains/inventory/dbt/models/gold/gld_inventory_turnover.sql:

1. **SQL Syntax Error (line 78-81):** Duplicate `SELECT * FROM final` with stray `)` — model won't compile at all.
2. **Non-existent column (line 31):** References `MAX(safety_stock) AS max_safety_stock` from fact_inventory_snapshot, but no safety_stock column exists anywhere (not in SQL model, Silver layer, or sample_inventory.csv seed).

Fix: Remove duplicate SELECT + stray parenthesis. Replace safety_stock reference with available column or remove the metric entirely.

---

## CSA-in-a-Box: Fabric-in-a-Box Vision
**Archon project ID**: `145c8d71-7e54-4135-8ec9-d6300caf4517`
**Tasks captured**: 109
**Status breakdown**: done:34, review:36, todo:39

### status: review (36)

#### CSA-0072 — No canonical mind map of services + patterns
_order: 110 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `1f237bb5-4a49-4609-b3fc-0541278fb868`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Shipped approved AQ-0022 scope: release-please + v0.1.0 release pipeline. New files: .release-please-config.json (Python release-type, csa-inabox, bump-minor-pre-major, 8 changelog sections), .release-please-manifest.json (seeds . at 0.1.0), .github/workflows/release-please.yml (googleapis/release-please-action@v4 on push-to-main), RELEASE.md runbook (release-please flow, manual v0.1.0 fallback, conventional-commit format, types/scopes). CHANGELOG.md rewritten to Keep-a-Changelog compatible format; prior [Unreleased] substance moved to [0.1.0] - 2026-04-20 entry; empty [Unreleased] placeholder for bot. pyproject.toml version="0.1.0" already correct. v0.1.0 tag NOT created — user cuts it via the release-please PR or manual git tag. Commit 95acf13. Ready for PR review.

Task-title note: original title "No canonical mind map of services + patterns" (DOC-NEW-0017) is a separate DOC need — the MIND_MAP.md content gap is unaddr...

#### CSA-0073 — Metadata framework CDC/streaming has no user docs
_order: 106 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `a0d0f3c8-09f3-40dd-9d3b-54b424d011c9`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Shipped approved AQ-0021 scope: quarterly DR drill CI workflow. .github/workflows/dr-drill.yml with cron (1st of Jan/Apr/Jul/Oct @ 10:00 UTC) + workflow_dispatch (environment: scratch/staging, scenarios: all | cosmos-failover | storage-failover | keyvault-restore | bicep-rollback). Shape: pre-flight → 4 parallel scenario jobs → report aggregator with if: always(). docs/runbooks/dr-drill.md (new) covers objectives/cadence/RBAC/scenarios/triggers/RPO-RTO. docs/DR.md cross-linked. Follow-up stubs documented (scripts/drill/*.sh, Teams webhook, scratch-fixture Bicep). Commit 1bf0058. Ready for PR review.

Task-title mismatch note: original title mentions "Metadata framework CDC/streaming has no user docs" (DOC-NEW-0018). The approved AQ-0021 scope is DR drills (what shipped). The metadata-framework docs gap is separate — should be tracked as a separate CSA-0073-followup if it hasn't been addressed.

[APPROVED 2026-04-18 — AQ-0...

#### CSA-0126 — Governance forked into two top-level trees with incompatible schemas
_order: 100 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `e1996f74-5a1f-4890-a4b1-f508c241eedb`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Consolidated governance trees. Moved csa_platform/purview_governance/ + top-level governance/{common,contracts,dataquality,finops,compliance,keyvault,network,policies,rbac} and governance/purview/{classification,glossary,scanning} under csa_platform/governance/ with purview/ subpackage. 35 Python imports rewritten, 6 YAML contracts + 4 compliance evidence paths updated, 4 CI workflows + pyproject + Makefile adjusted, 15 docs updated. compliance/validate.py parents[2]→parents[3] + manifest prefix fix. 978 tests pass (425 csa_platform + 84 portal + 156 CLI + 269 misc + 34 governance-local + 1 xfail). Ruff clean. Compliance validator clean across 304 controls / 231 evidence. Commit bb6efd5. Ready for PR review.

[APPROVED 2026-04-18 — AQ-0025 / Theme E] Approval granted: Governance tree merger to csa_platform/governance/ with subpackages (purview/, quality/, compliance/, rbac/, policies/, finops/, contracts/). Single codemod...

#### Copilot chat — backend telemetry pipeline (App Insights + Cosmos DB)
_order: 100 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `ca2e902d-5a20-442a-b2f1-c20822ffcc96`_

Wire Application Insights custom events + Cosmos DB persistence into azure-functions/copilot-chat/function_app.py. App Insights for ops/perf metrics; Cosmos DB for chat content / feedback / backlog with 90-day TTL. Use system-assigned MI for Cosmos auth. Add storage.py + telemetry.py + redaction.py modules. Update requirements.txt with azure-cosmos and azure-monitor-opentelemetry.

#### Copilot chat — feedback endpoint + thumbs UI
_order: 97 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `7ca36b8a-78ca-4122-a00e-5ba6aa0a5c17`_

New POST /api/feedback endpoint on the Function App: same origin/token gates as /api/chat. Accepts {session_id, conversation_id, rating: up|down, improvement_text?}. Persists to Cosmos `feedback` container; emits App Insights chat.feedback event. Frontend: 👍/👎 buttons under each assistant message. Thumbs-down opens a textarea modal asking 'How can we improve?'. Inline confirmation pill on submit.

#### CSA-0122 — Auth gating short-circuited unless NODE_ENV=production; staging bypasses MSAL
_order: 95 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `f340c690-2f0c-4138-9d91-91c0365f91cc`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Gated MSAL auth by explicit NEXT_PUBLIC_AUTH_ENABLED env var. Added resolveAuthEnabled() helper with precedence: explicit true/false wins; unset falls back to NODE_ENV==='production' (fail closed in prod, demo in dev/test). _app.tsx refactored to use the helper. .env.example + README documented. 5 new tests in __tests__/pages/_app.test.tsx. Frontend suite 91/91 green (+5). Coordinated with backend CSA-0001/0019 allow-list. Commit e79800e. Ready for PR review.

Next.js subtlety noted: NEXT_PUBLIC_* are statically inlined at `next build`, so pre-prod builds must set the flag at build time.

[APPROVED 2026-04-18 — AQ-0013 / Theme C] Approval granted: Gate staging/preview auth by NEXT_PUBLIC_AUTH_ENABLED alone; treat production/staging/preview identically. Coordinate rollout with CSA-0001 + CSA-0019 fixes.

#### Copilot chat — backlog endpoint + use-case request UI + uncovered detection
_order: 94 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `3617fc72-1259-4dc0-8e77-14d28e49506c`_

New POST /api/backlog endpoint accepting {kind: feature|bug|uncovered, title, description, session_id?, conversation_id?}. Persists to Cosmos `backlog` container. Implicit-uncovered: when backend returns the canned off-topic refusal OR grounding doc count is zero, also emit a backlog item with kind=uncovered referencing the original question. Frontend: 'Request a use case' button in widget header opens modal; on uncovered detection, widget surfaces a 'Was this question something we should cover? Add to backlog' inline prompt. Then a GitHub Action drains the Cosmos backlog and opens GitHub Issues.

#### Copilot chat — privacy notice + opt-out banner
_order: 91 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `06f07e40-04e7-4eda-ae3b-5616e86acb18`_

New docs/copilot-privacy.md explaining what's logged (chat content, page url, hashed IP, latency, tokens), retention (90 days raw / aggregated indefinitely), redaction (emails / secret-shaped strings stripped), opt-out instructions. Frontend: dismissible privacy banner on first widget open with 'Accept' / 'Opt out' / 'Read details'. Opt-out persists via localStorage; backend honors a header X-Copilot-Opt-Out: 1 by skipping all logging while still serving the response.

#### Security audit — Copilot chat surface + repo + docs
_order: 89 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `94abbb26-96d5-4093-ae97-08c7995dcf57`_

Background agent producing temp/security-audit-2026-05-06.md covering: chat widget XSS / link handling / SubtleCrypto fallback / external CDN with no SRI, Function backend (origin / token / rate limit / regex injection list), Function deployment hardening, repo secrets scan, supply-chain (requirements.txt + workflows mutable tags), docs site CDN inclusions. Then triage findings into Archon tasks.

#### CSA-0131 — csa_platform/data_marketplace/ parallel marketplace API — deprecated but still shipped/tested/documented
_order: 87 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `8f47d6a3-a62d-4c19-a873-7baa6e88b0d9`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context) — PORTAL/CLI PORTION] Shipped the portal/cli → cli/ portion of the approved AQ-0030 scope. Moved 19 files via git mv (history preserved); 9 test files + __main__.py updated to use `from cli.X`; cli/README.md prepended with CSA-0131/AQ-0030 disambiguation note, 30+ python -m invocations rewritten, test/coverage paths updated; pyproject.toml tool.ruff.src extended; root README repository-structure tree adds cli/ as sibling of portal/ with "3 UI frontends" annotation. 156 CLI tests + 433 csa_platform + 91 portal tests all green. Commit 27a30d6.

Remaining scope for this CSA ID:
  * Complete deprecation/removal of parallel csa_platform/data_marketplace/ (ARCH-0001 Phases 2-4) — still open from prior session. Not started.
  * Regenerate CLI from OpenAPI spec — not started. Separate follow-up.

[APPROVED 2026-04-18 — AQ-0030 / Theme E] Approval granted: Promote portal/cli/ → top-level cli/; complete deprecation/removal of parall...

#### Copilot chat — Claude Code GitHub App auto-fix workflow
_order: 87 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `ce8124c3-20b5-4d93-a990-285d1f04df8d`_

Issue templates (csa-bug, csa-feature-request, csa-uncovered). Workflow .github/workflows/copilot-auto-fix.yml triggered on label `auto-fix` on issues labeled `csa-bug`. Uses anthropics/claude-code-action; opens PR titled 'fix: <issue title> (auto-fix)'. Sibling workflow .github/workflows/copilot-auto-merge.yml watches PRs from the auto-fix bot; if all required checks pass AND the diff is contained within a configurable safelist of paths (default: docs/**, examples/**, .github/ISSUE_TEMPLATE/**), enables GitHub auto-merge. Anything outside the safelist requires human review.

#### CSA-0132 — azure_clients.py factory lacks retry, timeout, circuit-breaker; 23 call sites bypass factory
_order: 85 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `40c711fa-9877-4d67-924f-eed61fcd7b40`_

[RESOLVED 2026-04-19 by session Claude Opus 4.7 (1M context)] Shipped approved rename: csa_platform/onelake_pattern/ → unity_catalog_pattern/ and csa_platform/direct_lake/ → semantic_model/. 16 files renamed via git mv (history preserved); 14 cross-reference files updated (Python imports, tests, docs, migration playbooks); disambiguation notes added to both module READMEs; legitimate Microsoft product terms preserved in prose. All 665 tests green (425 csa_platform + 84 portal + 156 CLI). Commit ce0b113. Ready for PR review.

Note: the original task title ("azure_clients.py factory lacks retry, timeout, circuit-breaker") is stale metadata. The approved AQ-0019 decision for this CSA ID was the module-rename work, which is what shipped. The retry/circuit-breaker concern on azure_clients.py is an open architectural gap that should be tracked as a separate CSA finding (candidate for Wave 5 or next audit cycle).

[APPROVED 2026-04-18 — AQ-0019 / Theme C] Approval granted: Rename csa_platf...

#### Implement Lambda Architecture for CSA Streaming Platform
_order: 85 . feature: streaming-architecture . assignee: User . id: `72bc34ea-4da4-42be-b362-5756ab1a3b01`_

Create comprehensive Lambda architecture implementation with EventProcessor, SpeedLayer, BatchLayer, and ServingLayer components. Includes Azure Event Hubs integration, real-time processing, batch reprocessing, and earthquake monitoring example. This implements the speed/batch/serving layer pattern for CSA-in-a-Box streaming capabilities.

#### Copilot chat — IaC for Cosmos DB container + RBAC + Bicep for Function App
_order: 84 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `72d7144d-7e33-48ff-80f4-b0e6ed65a62f`_

Address the IaC gap called out in azure-functions/copilot-chat/DEPLOYMENT.md. Create azure-functions/copilot-chat/deploy/main.bicep: Function App (existing Y1 plan reference), App Insights (existing reference), Cosmos DB account + database + 3 containers (conversations / feedback / backlog) with TTL on conversations, role assignment binding the Function App MI to Cosmos Built-in Data Contributor. Document manual provisioning fallback in DEPLOYMENT.md.

#### CSA-0127 — csa_platform/shared_services/ and domains/sharedServices/ overlap (snake_case vs camelCase)
_order: 78 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `cf0f845e-4db9-4e71-9b62-7319ff3503d0`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Merged csa_platform/shared_services/ (v1 deployable Function App) + domains/sharedServices/ (aiEnrichment/eventProcessing/secretRotation + common lib) into csa_platform/functions/ with subdirs: common/ (lib), validation/ (formerly shared_services/), aiEnrichment/, eventProcessing/, secretRotation/. Empty domains/sharedServices/ removed. 4 Python imports + 4 test path updates + pyproject coverage sources + Makefile mypy invocations + .github/workflows/test.yml + CODEOWNERS + vscode configs + 10 docs updated. 425+84+156+69+33 = 767 tests pass, 1 pre-existing xfail; ruff clean. Commit 02d8b51. Ready for PR review.

[APPROVED 2026-04-18 — AQ-0026 / Theme E] Approval granted: Shared-services merger to csa_platform/functions/ (single Function App). Two-PR sequence (add new Function App, retire old).

#### SEC-COPILOT — H-5b: deploy-copilot-function.yml broken; SCM basic auth is disabled
_order: 76 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `9956857c-d198-4024-b6c3-fc82a8b40485`_

Discovered 2026-05-06 during the live deploy: the existing .github/workflows/deploy-copilot-function.yml uses Azure/functions-action@v1 with publish-profile auth, but SCM basic auth is disabled on func-csa-inabox-copilot-fg. Result: 401 Kudu when fetching app settings. Workaround used today: direct `func azure functionapp publish` from the maintainer's az CLI session. Fix: update the workflow to use azure/login@v2 with SP-based or OIDC auth, and grant the SP `Website Contributor` on the Function App. Also pin Azure/functions-action to a SHA per H-5.

#### CSA-0138 — Error flows silently swallow failures; no dead-letter path for async workflows
_order: 75 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `fa7327d8-9802-4af7-9d26-f96665f49c4d`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Shipped canonical DLQ pattern. deploy/bicep/shared/modules/deadletter/deadletter.bicep (235 lines, 4 resources: deadletter-<pipelineName> container + Event Grid system topic + subscription + diagnostic settings + metric alert; typed params with @minValue/@maxLength; outputs containerUri, eventGridSubscriptionId, alertRuleId). az bicep build clean. docs/runbooks/dead-letter.md (243 lines) — operator runbook with 5-step triage (az CLI commands), Replay for Databricks Autoloader + ADF + Event Hubs consumer, Drop with CSA-0016 audit emission, Escalation P1 criteria, per-pipeline inventory table stub. ARCHITECTURE.md + PLATFORM_SERVICES.md cross-refs added. Commit e69bb7d. Ready for PR review.

Remaining approved scope not addressed this session: wiring the DLQ pattern into data_activator, writing the full FailedOperation Pydantic model, Cosmos persistence layer, and portal UI surface for viewing failed operations. That work p...

#### CSA-0128 — Data mesh domains/ is centralized-pretending-to-be-federated
_order: 74 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `aad0285b-c945-4ce4-ba24-102a322e17e5`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Shipped approved AQ-0027 scope — documented + scaffolded the contract-driven mesh federation model. ADR-0012 (196 lines, MADR) captures the 4-stage pipeline (contract.yaml → CI validates → Purview registers → portal surfaces) with 3 considered options, NIST AC-3/CA-2/CM-3 mapping, validation criterion. docs/adr/README.md index row added. .github/CODEOWNERS extended with per-domain sections for finance/inventory/dlz/spark/ (shared and sales already present) under CSA-0128/AQ-0027/ADR-0012 banner with TODO marker for real team handles. domains/README.md federation-model callout at top. validate-contracts.yml already thorough — no changes. Commit 4bb868b. Ready for PR review.

Remaining approved scope not addressed (candidate follow-ups):
  * Build domain templates for csa domain new CLI scaffolding
  * Move domains/shared/ → csa_platform/mesh_shared/ (architectural, pairs with the broader csa_platform/ consolidation done in...

#### CSA-0139 — Persistence layer is file-backed SQLite-JSON hybrid at module scope — blocks horizontal scale
_order: 73 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `0425662f-675b-4b03-b3ac-ed27ad3b40d5`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Shipped approved AQ-0034 scope: marked csa_platform/multi_synapse/ legacy/migration-only. README banner prepended with forward links to ADR-0002 + decision tree + 4-row migration-target table. New MIGRATION.md (257 lines) covers capability-mapping matrix, per-capability notes, 4-phase sequencing, cross-links to ADRs/decision docs/migration playbooks/Unity Catalog/Semantic Model. 1-line legacy notes added to csa_platform/README.md, docs/ARCHITECTURE.md, docs/PLATFORM_SERVICES.md. Decision tree + YAML already positioned Synapse as legacy — no inconsistency found. Module NOT renamed / moved / deleted — existing customers retain deploy path. Commit c93c779. Ready for PR review.

Remaining scope for the AQ-0034 approved package (not done this session; candidate future tickets):
  * Freeze net-new features on multi_synapse (policy / CODEOWNERS enforcement)
  * Lift workspace abstraction to csa_platform/workspace/ with synapse_p...

#### SEC-COPILOT — H-3: drop AZURE_OPENAI_KEY, use system-assigned MI for OpenAI
_order: 72 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `66dd7226-1382-4322-a096-edc615ab6456`_

Audit finding H-3 (temp/security-audit-2026-05-06.md). Function App MI already exists. Switch the AzureOpenAI client to azure_ad_token_provider via DefaultAzureCredential and grant the Function MI the 'Cognitive Services OpenAI User' role on the AOAI account. Drop AZURE_OPENAI_KEY from app settings. Coordinate with deploy/main.bicep IaC PR so role assignment is captured.

#### CSA-0130 — Medallion has two parallel implementations: dbt and Databricks Spark notebooks
_order: 71 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `59b842a1-4ae7-4267-ae34-c99aa4c5c89d`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Shipped approved AQ-0029 scope: dbt as canonical transformation layer. ADR-0013 (197 lines, MADR) makes the policy explicit — dbt Core is canonical for Bronze→Silver→Gold; Spark notebooks remain appropriate only for ad-hoc exploration, OPTIMIZE/VACUUM, Unity Catalog provisioning, MLflow, and streaming ingestion. 3 considered options; NIST CM-3/CM-4/SI-10 control mapping. docs/adr/README.md index row added. Deprecation banner added to domains/shared/notebooks/databricks/bronze_to_silver_spark.py (the one medallion-duplicate notebook); 7 other notebooks intentionally left without banner (correctly out-of-scope for dbt). New domains/shared/notebooks/README.md explains the tree's non-medallion purpose with Canonical vs Deprecated inventory. csa_platform/README.md skipped (no transformation section to update). Commit add9794. Ready for PR review.

[APPROVED 2026-04-18 — AQ-0029 / Theme E] Approval granted: dbt as canonical tra...

#### SEC-COPILOT — H-5: pin Azure/functions-action@v1 to SHA
_order: 69 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `7ac11b22-66d0-40c1-baec-fa2fc0a85679`_

Audit finding H-5 (temp/security-audit-2026-05-06.md). .github/workflows/deploy-copilot-function.yml line ~70 references Azure/functions-action@v1 (mutable tag). Look up current release SHA from https://github.com/Azure/azure-functions-app-action/releases, pin, and let Dependabot keep it current. Already SHA-pinned: actions/checkout, actions/setup-python.

#### CSA-0050 — Repo root has stale Azurite emulator artifacts and test outputs committed
_order: 58 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `4c1bcc94-a9d3-47d2-b8d0-2d16571faf1e`_

Layer: DX | Severity: LOW | Category: BUG | Action: FIX | Vision: N/A
File/Location: /__azurite_db_blob__.json, /__azurite_db_blob_extent__.json, /__blobstorage__/, .coverage, logs/dbt.log
Description: Left-over local-emulator state at repo root; untracked but confusing; risk of accidental commit.
Fix: git rm committed artifacts; add patterns to .gitignore; add hygiene CI check.
Effort: XS | Requires Approval: NO | Source perspectives: 4,6 | Source IDs: OPS-NEW-0012, NEW-NEW-0016
[RESOLVED 2026-04-18 by session Claude Opus 4.7 (1M context)] Verified Azurite artifacts (__azurite_db_blob__.json, __azurite_db_blob_extent__.json, __blobstorage__/) already in .gitignore (lines 110-116); git ls-files confirms none tracked. No changes needed. Tests: 39 new auth-gate tests added; 632 total pass. Ready for PR review.

#### CSA-0087 — No ADRs / decision records
_order: 50 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `371ec329-567e-4d20-937b-0f156bed892b`_

[RESOLVED 2026-04-19 by session Claude Opus 4.7 (1M context)] Shipped 10 MADR ADRs (0001 ADF+dbt, 0002 Databricks, 0003 Delta, 0004 Bicep, 0005 Event Hubs, 0006 Purview, 0007 Azure OpenAI, 0008 dbt Core, 0009 SQLite→Postgres, 0010 Fabric target) + index README. Every ADR cites real repo artifacts; NIST/HIPAA mappings where relevant; forward-linked to docs/decisions/. Commit fe6ca97. Ready for PR review.

[APPROVED 2026-04-18 — AQ-0006 / Theme B] Approval granted: Author all 10 ADRs, lightweight MADR format. Ready for execution.
Layer: DOCS | Severity: MEDIUM | Category: MISSING_CONTENT | Action: ADD | Vision: 4
File/Location: docs/adr/ or docs/decisions/ (both absent)

#### Add write endpoints to CSA-in-a-Box data marketplace
_order: 50 . feature: marketplace-api . assignee: User . id: `ebb09fad-d9fc-413d-8c93-1485a4834e9a`_

Extend the marketplace router with write endpoints for full CRUD operations:

1. POST /products - Register new data product
2. PUT /products/{id} - Update existing product  
3. DELETE /products/{id} - Delete product (admin only)
4. POST /products/{id}/quality - Trigger quality assessment
5. POST /access-requests - Create access request
6. GET /access-requests - List requests (filtered by user)
7. GET /access-requests/{id} - Get request details
8. PUT /access-requests/{id}/approve - Approve request
9. PUT /access-requests/{id}/deny - Deny request

Create DataProductCreate model as needed. Follow existing patterns: domain scoping, dependency injection, AsyncStoreBackend, error handling.

#### CSA-0140 — Multi-cloud vision unfunded — no AWS or GCP module, yet vision promises multi-cloud
_order: 49 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `79a6e5ed-5726-41c3-b030-a333a5ed066e`_

[RESOLVED 2026-04-20 by session Claude Opus 4.7 (1M context)] Shipped approved AQ-0035 scope as ADR-0011 (docs/adr/0011-multi-cloud-scope.md, 169 lines, MADR format). Decision: scope multi-cloud to OneLake shortcuts (S3 + GCS read-only) + Purview cross-cloud scans (Snowflake/BigQuery/Redshift catalog + classification). Deferred: Unity Catalog federation, Denodo, Trino, cross-cloud compute, cross-cloud writes. 4 considered options analyzed with honest pro/con; validation criterion defined (>30% cross-cloud-compute asks in 6 months triggers ADR-0012 revisit). References Vision §1, ADR-0006/0010, 4 migration playbooks, decision trees, NIST 800-53 CA-3/AC-4/CM-7. docs/adr/README.md index row added. ARCHITECTURE.md edit NOT needed — section already honest; only multi-cloud mention is a correct Terraform statement. Commit 7c2c803. Ready for PR review.

Follow-up sweep recommended (not this scope): docs/VISION.md §1, PLATFORM_SERVICES.md, top-level README.md — any multi-cloud parity langua...

#### CSA-0060 — No canary/blue-green; default 25/25 rolling update; no Argo Rollouts example
_order: 40 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `307051c8-ed10-4282-8974-789aee1a2755`_

Layer: INFRASTRUCTURE | Severity: LOW | Category: DESIGN_FLAW | Action: ADD | Vision: 6
File/Location: portal/kubernetes/helm/csa-portal/templates/backend.yaml, deploy-portal.yml
Fix: Optional Argo Rollouts template (flag-gated) or document strategy.rollingUpdate overrides.
Effort: M | Requires Approval: NO | Source perspectives: 4 | Source IDs: OPS-NEW-0023

#### CSA-0062 — make setup installs only dev/governance/functions; misses [portal], [platform]
_order: 38 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `e3804c30-3299-4d69-a23a-2004acbf060c`_

Layer: DX | Severity: LOW | Category: DX | Action: FIX | Vision: 6
File/Location: Makefile:11-22
Fix: Default to [dev,governance,functions,portal,platform] or add setup-all target.
Effort: XS | Requires Approval: NO | Source perspectives: 4 | Source IDs: OPS-NEW-0025

#### CSA-0071 — Vertical count inconsistency across docs (9 vs 10)
_order: 36 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `739807b4-05db-48a9-bddd-bf78a5384688`_

Layer: DOCS | Severity: LOW | Category: DOCUMENTATION | Action: FIX | Vision: 5
File/Location: README.md:125, docs/ARCHITECTURE.md:347, examples/README.md:8, docs/GETTING_STARTED.md:212
Fix: Canonicalize to "10 examples (9 verticals + iot-streaming cross-cutting pattern)."
Effort: XS | Requires Approval: NO | Source perspectives: 5 | Source IDs: DOC-NEW-0016

#### CSA-0077 — dbt tag pattern in batch diagram doesn't match example code
_order: 33 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `e8fb96e5-e679-4dd4-8e18-5a807a2af68e`_

Layer: DOCS | Severity: LOW | Category: BUG | Action: FIX | Vision: 5
File/Location: docs/ARCHITECTURE.md:308-316
Fix: Add diagram note "Each step is dbt run --select tag:<layer> from a single dbt project."
Effort: XS | Requires Approval: NO | Source perspectives: 5 | Source IDs: DOC-NEW-0023

#### CSA-0079 — Cross-doc "Related Documentation" footers inconsistent
_order: 31 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `06b89311-0837-40e8-aecf-63f6c9fd1bce`_

Layer: DOCS | Severity: LOW | Category: DOCUMENTATION | Action: FIX | Vision: Cross-cutting
File/Location: Bottom of every docs/*.md
Fix: Standard footer: 3 links (prev step, next step, parent index). Apply across all 20 docs.
Effort: M | Requires Approval: NO | Source perspectives: 5 | Source IDs: DOC-NEW-0026

#### CSA-0081 — Expected-row-counts only in QUICKSTART; missing per-vertical README
_order: 29 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `87942553-8f78-4ab0-ad2e-1e748705d712`_

Layer: DOCS | Severity: LOW | Category: DOCUMENTATION | Action: ADD | Vision: 5
File/Location: Each examples/*/README.md
Fix: "Expected Results" section with approximate row counts per Gold table.
Effort: M | Requires Approval: NO | Source perspectives: 5 | Source IDs: DOC-NEW-0029

#### CSA-0084 — params.multi-region.json / params.multi-tenant.json exist but undocumented
_order: 27 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `fc2dd6dd-f415-4703-8242-3b26708643ee`_

Layer: DOCS | Severity: LOW | Category: DOCUMENTATION | Action: ADD | Vision: 1
File/Location: docs/MULTI_REGION.md, docs/MULTI_TENANT.md
Fix: Inline block showing deploy/bicep/DLZ/params.multi-region.json as starter template.
Effort: XS | Requires Approval: NO | Source perspectives: 5 | Source IDs: DOC-NEW-0033

#### CSA-0109 — Default embedding model underpowered for code/tech corpus
_order: 24 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `1221c9ec-1fd5-43ea-a551-8686c1215d74`_

Layer: AI | Severity: LOW | Category: DESIGN_FLAW | Action: REFACTOR | Vision: 7
File/Location: csa_platform/ai_integration/rag/config.py:42
Fix: Default to text-embedding-3-large (3072 dims); benchmark on golden set.
Effort: XS | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0019 | Deps: CSA-0023

#### CSA-0117 — Enrichment modules inconsistent async/sync (block event loop in FastAPI)
_order: 22 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `1c5afa95-6abe-48c7-ab27-7ccd6b64e11e`_

Layer: AI | Severity: LOW | Category: DESIGN_FLAW | Action: REFACTOR | Vision: 7
File/Location: csa_platform/ai_integration/enrichment/*.py
Fix: Async variants of all enrichment classes; document sync paths as batch-only.
Effort: M | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0027

#### CSA-0076 — Tutorial clone URL hardcoded to personal GitHub (fgarofalo56)
_order: 21 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `68454b8e-4059-4455-a722-1fe2f4c54319`_

[RESOLVED 2026-04-19 by session Claude Opus 4.7 (1M context)] Hardcoded personal clone URL replaced with <CLONE_URL> placeholder + canonical README callout. Commit 0bd5700. Ready for PR review.
[APPROVED 2026-04-18 — AQ-0023 / Theme D] Approval granted: Abstract clone URL to <clone-url> placeholder across tutorials; README pointer for canonical repo location. Ready for execution.
Layer: DOCS | Severity: LOW | Category: DOCUMENTATION | Action: FIX | Vision: 6
File/Location: docs/QUICKSTART.md:54, docs/GETTING_STARTED.md:68, others
Fix: Formalize personal GitHub as canonical (and say so) OR abstract to <clone-url> with README pointer.
Effort: XS | Requires Approval: YES (depends on repo ownership strategy) | Source perspectives: 5 | Source IDs: DOC-NEW-0021

### status: todo (39)

#### CSA-0075 — USDA tutorial dbt profile assumption unstated (no profiles.yml template)
_order: 113 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `b38f409c-8a3e-4e83-9541-3c59429d05ef`_

Layer: DOCS | Severity: MEDIUM | Category: BUG | Action: FIX | Vision: 5
File/Location: docs/QUICKSTART.md:356-372, examples/usda/README.md
Fix: Add examples/usda/domains/dbt/profiles.yml.example (DuckDB + Databricks targets); update QUICKSTART to say "local-first with DuckDB."
Effort: S | Requires Approval: NO | Source perspectives: 5 | Source IDs: DOC-NEW-0020

#### CSA-0100 — No agentic patterns / tool registry / plan-act loop
_order: 112 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `bc5fa06a-f715-4775-bc39-5ff8b956787e`_

[APPROVED 2026-04-18 — AQ-0003 / Theme A] Approval granted: Agent framework = PydanticAI. Reserve option to add LangGraph later if multi-agent orchestration needed. Ready for execution.
Layer: AI, COPILOT | Severity: HIGH | Category: MISSING_FEATURE | Action: BUILD_NEW | Vision: 7
File/Location: NEW: apps/copilot/agent.py, apps/copilot/tools/
Fix: PydanticAI-based agent loop; typed tool registry with permission scopes; max-N-step hard cap.
Effort: L | Requires Approval: YES | Source perspectives: 7 | Source IDs: AI-NEW-0008 | Deps: CSA-0008

#### CSA-0129 — Fabric primacy claim is token gesture — code targets Synapse/Databricks, not Fabric
_order: 111 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: Coding Agent . id: `dbd7a615-9448-4cae-a071-f6edb6fab263`_

[APPROVED 2026-04-18 — AQ-0028 / Theme E] Approval granted: Build real csa_platform/fabric/ module. Phased: Phase 1 rename + honest naming; Phase 2 Fabric capacity/workspace Bicep; Phase 3 REST client + Direct Lake publisher; Phase 4 Fabric Data Agent (ties to AQ-0001). Ready for execution.
Layer: ARCHITECTURE | Severity: CRITICAL | Category: VISION_GAP | Action: BUILD_NEW | Vision: 1
File/Location: csa_platform/direct_lake/scripts/generate_semantic_model.py (generates YAML; does not call Fabric Semantic Model REST API); configure_sql_endpoint.py (Synapse Serverless SQL, not Fabric SQL endpoint); csa_platform/onelake_pattern/unity_catalog/shortcut_manager.py (Unity Catalog shortcuts, despite module name); onelake_pattern/deploy/onelake-storage.bicep (generic Storage ADLS gen2, not Fabric); Zero references to Microsoft.Fabric/* resource provider; Zero calls to Fabric REST; csa_platform/multi_synapse/ full Synapse automation with no Fabric counterpart
Description: Vision §1 positions ...

#### CSA-0034 — Key Vault gov template uses networkAcls.bypass: 'AzureServices'
_order: 108 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `ea058885-5b13-4ce8-acdd-e3d89d8a6729`_

Layer: SECURITY | Severity: LOW | Category: SECURITY | Action: FIX | Vision: 1
File/Location: deploy/bicep/gov/main.bicep:142-146
Description: bypass: 'AzureServices' broader than IL5/HIPAA ideal; permits any MS-trusted first-party service.
Fix: Parameterize keyVaultBypassAzureServices (default false in gov IL5/HIPAA); document trade-off.
Effort: XS | Requires Approval: NO | Source perspectives: 2 | Source IDs: SEC-NEW-0021

#### CSA-0035 — SQLite portal.db committed to repo; no encryption-at-rest
_order: 106 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `31017fb3-23f2-499d-9137-989a0baf5212`_

Layer: SECURITY, DX | Severity: LOW | Category: SECURITY | Action: FIX | Vision: 5
File/Location: data/portal.db, portal/shared/api/persistence.py:26-54
Description: Committed SQLite DB; no SQLCipher; operators may accidentally ship to prod.
Fix: .gitignore data/*.db*; swap to Cosmos/Postgres for non-local envs (paired with CSA-0041).
Effort: XS | Requires Approval: NO | Source perspectives: 2 | Source IDs: SEC-NEW-0022 | Deps: CSA-0041

#### CSA-0112 — No content safety / moderation on user input (prompt injection vector)
_order: 105 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `73387ee6-6643-4ab2-a472-f7dfa25fffce`_

Layer: AI, SECURITY | Severity: HIGH | Category: MISSING_FEATURE | Action: ADD | Vision: 7
File/Location: NEW: csa_platform/ai_integration/safety/content_safety.py
Description: Bicep raiPolicyName: 'Microsoft.Default' is floor; no app-layer Azure AI Content Safety on input/output, no prompt-injection defense, no PII redaction.
Fix: Content Safety pre-filter; PII NER → redact-then-log; output filter; protectedMaterialAnalysis + jailbreakDetection.
Effort: M | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0022

#### CSA-0080 — No static OpenAPI doc for portal FastAPI
_order: 103 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `3d2a2b14-660f-4665-9a4f-bcfbdce87569`_

Layer: DOCS | Severity: MEDIUM | Category: MISSING_CONTENT | Action: ADD | Vision: 5
File/Location: NEW: docs/api/
Fix: Commit generated docs/api/openapi.json via CI or render via mkdocs + mkdocstrings; docs/api/README.md summary.
Effort: M | Requires Approval: NO | Source perspectives: 5 | Source IDs: DOC-NEW-0027

#### CSA-0120 — Wizard missing tags, data_product, cost_center, target.path_pattern, partition_by
_order: 100 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `8d167651-d2ec-402d-8c5a-e219a2a595d1`_

Layer: FRONTEND | Severity: HIGH | Category: DESIGN_FLAW | Action: ADD | Vision: 5
File/Location: portal/react-webapp/src/components/register/*, portal/shared/contracts/types.ts:134-149
Fix: Add "Metadata & Publishing" step: tags key/value list, toggle "Publish as data product" → data_product.name/description/sla, cost_center.
Effort: M | Requires Approval: YES (wizard flow change) | Source perspectives: 3 | Source IDs: UX-NEW-0008 | Deps: CSA-0007

#### CSA-0036 — Access request duration_days unbounded (int); 100-year tokens possible
_order: 95 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `b4ff1b84-fc5f-4466-873b-965f28fe0097`_

Layer: SECURITY | Severity: LOW | Category: BUG | Action: FIX | Vision: 3
File/Location: portal/shared/api/models/marketplace.py (AccessRequestCreate.duration_days)
Description: No ge/le. duration_days=36500 accepted.
Fix: Field(..., ge=1, le=365); classification-based caps.
Effort: XS | Requires Approval: NO | Source perspectives: 2 | Source IDs: SEC-NEW-0023 | Deps: CSA-0017

#### CSA-0123 — NEXT_PUBLIC_API_URL defaults differ between next.config.js and api.ts
_order: 90 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `96aa4e74-12d0-4965-844a-e0c880b5c8e0`_

Layer: FRONTEND | Severity: MEDIUM | Category: BUG | Action: FIX | Vision: N/A
File/Location: portal/react-webapp/next.config.js:6,12, portal/react-webapp/src/services/api.ts:21
Fix: Align both to http://localhost:8000/api/v1; document in README.
Effort: XS | Requires Approval: NO | Source perspectives: 3 | Source IDs: UX-NEW-0012

#### CSA-0135 — Committed Python virtualenvs in git (tools/dbt/dbt-env/ and aiEnrichment/.venv/)
_order: 88 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `5e95eb59-d3b7-4fe6-b0ea-6e22c27de4db`_

Layer: ARCHITECTURE, DX | Severity: HIGH | Category: DEAD_WEIGHT | Action: REMOVE | Vision: 6
File/Location: tools/dbt/dbt-env/{Include,Lib,Scripts,pyvenv.cfg,share}; domains/sharedServices/aiEnrichment/functions/.venv/ (Azure SDK site-packages committed — 20+ files under .venv/Lib/site-packages/azure/functions/)
Description: Python virtualenv committed to git under tools/dbt/dbt-env/. Separately, domains/sharedServices/aiEnrichment/functions/.venv/ has entire virtualenv committed. DevOps flagged one; architect finds second, larger offender. Virtualenvs are OS-specific, tens of thousands of files, and must never be committed. Two separate venvs suggests .gitignore missing or misconfigured per-subdir.
Impact: Massive repo bloat (hundreds of MB); cross-platform breakage (Windows venv won't run on Linux CI); security — bundled deps cannot be patched via Dependabot; every git clone downloads OS-specific binaries useless on target.
Fix: (1) git rm -rf tools/dbt/dbt-env/ and git rm -rf do...

#### CSA-0082 — No canonical source-of-truth diagram files per reference architecture
_order: 87 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `19c0d5f2-9375-46ca-9ea4-a8e6a82c2118`_

Layer: DOCS | Severity: MEDIUM | Category: MISSING_CONTENT | Action: BUILD_NEW | Vision: 1
File/Location: NEW: docs/diagrams/
Fix: docs/diagrams/*.mmd source files; CI normalization check; optional SVG render under docs/diagrams/rendered/.
Effort: M | Requires Approval: NO | Source perspectives: 5 | Source IDs: DOC-NEW-0031

#### CSA-0137 — Streaming is not first-class — no unified streaming contract between EH/ASA/ADX/medallion
_order: 84 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `47b943af-3df9-48ac-84ab-a0c22e2c0ada`_

[APPROVED 2026-04-18 — AQ-0032 / Theme E] Approval granted: Build csa_platform/streaming/ spine (source contract, Bronze-as-stream, Silver materialized views, Gold contract with latency SLO, dbt integration). Sequence after AQ-0028 (Fabric module). Ready for execution.
Layer: ARCHITECTURE | Severity: HIGH | Category: MISSING_FEATURE | Action: BUILD_NEW | Vision: 1
File/Location: deploy/bicep/DLZ/modules/{eventhubs,streamanalytics,dataexplorer}/ — infrastructure exists; examples/iot-streaming/ (README-only, no ARCHITECTURE.md unlike others); scripts/streaming/produce_events.py producer exists; No csa_platform/streaming/ module; no streaming contract; no streaming pipeline generator in metadata_framework/templates/ (adf_streaming.json is batch-ADF-streaming, not genuine streaming architecture); domains/{finance,sales,inventory}/dbt/ all batch; no streaming silver/gold
Description: Vision §1 requires streaming first-class. Repo has streaming infrastructure (EventHub, Stream Analytics, ...

#### CSA-0037 — /api/health triple-path surface confusing; include_in_schema=False not a security boundary
_order: 83 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `5749dd34-14aa-4efe-b338-c9a4b9f1fd4d`_

Layer: SECURITY | Severity: LOW | Category: DESIGN_FLAW | Action: FIX | Vision: N/A
File/Location: portal/shared/api/main.py:214-249
Description: Three routes (/api/health/live, /api/v1/health, /api/health/ready, /api/health) with one hidden from schema. Reachable anyway.
Fix: Keep /api/health/live (probe) and /api/v1/health (schema). Drop unauth aliases or move behind admin.
Effort: XS | Requires Approval: NO | Source perspectives: 2 | Source IDs: SEC-NEW-0024

#### SEC-COPILOT — H-1: rate limits + budget are per-instance / reset on cold start
_order: 80 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `a1e815db-5deb-477f-8047-19261eb0c4bb`_

Audit finding H-1 (temp/security-audit-2026-05-06.md). The in-memory dicts in azure-functions/copilot-chat/function_app.py reset on each cold start and are per-instance on Consumption plan. Fix: back the rate-limit + token budget with Azure Storage Tables (or Cosmos) so limits are durable across instances, OR layer Azure Front Door / APIM rate-limit policy in front of the Function App. Document the chosen approach in DEPLOYMENT.md.

#### SEC-COPILOT — Rotate limitlessdata_deploy SP secret
_order: 77 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: User . id: `1645804f-6684-4c07-b1ca-31a4e41ede71`_

The SP secret was transmitted in plaintext in the 2026-05-06 deploy session and is also stored in the GitHub repo secret AZURE_CLIENT_SECRET. Rotate via Azure Portal → Entra → App registrations → limitlessdata_deploy → Certificates & secrets → New client secret. Then `gh secret set AZURE_CLIENT_SECRET --body <new-value>` and delete the old secret in the portal. Follow-up consideration: migrate to OIDC federated credential to avoid keeping a long-lived client secret in GitHub at all.

#### SEC-COPILOT — H-2: replace regex prompt-injection list with Azure AI Content Safety
_order: 75 . feature: COPILOT-ANALYTICS-2026-05-06 . assignee: Coding Agent . id: `45297419-21e7-4f30-9e87-991b6633d871`_

Audit finding H-2 (temp/security-audit-2026-05-06.md). The 24-pattern regex in function_app.py is bypassable by leetspeak, full-width chars, zero-width space insertion, translation, base64, or multi-turn splits. Move to Azure AI Content Safety Prompt Shield for input filtering, plus an output-side hostile-string + HTML strip pass before returning to the widget. Keep regex as a low-effort tripwire that emits chat.rejected/injection telemetry.

#### CSA-0136 — csa_platform/metadata_framework/output/ is a committed build artifact directory
_order: 73 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `665e993a-cec1-4fde-835b-4bf68c73754d`_

Layer: ARCHITECTURE, DX | Severity: MEDIUM | Category: DEAD_WEIGHT | Action: REMOVE | Vision: 6
File/Location: csa_platform/metadata_framework/output/pl_sales_database_incremental.{deployment,parameters}.json; pl_sales_database_incremental.json; output/dlz/dlz-lz-sales-transactions.{deployment,parameters,purview-scans,rbac,storage-structure}.json
Description: Metadata framework is code generator (auto-generates ADF pipelines, Purview scans, RBAC, storage structures from source registration metadata — IMPLEMENTATION_COMPLETE.md documents it). output/ directory holds sample generator outputs committed to git. Generated artifacts never belong in source control — derivable by design. If example outputs for documentation, belong in csa_platform/metadata_framework/examples/ clearly labeled. If stale runs, delete.
Impact: Contributors cannot distinguish output from input — generator's contract ambiguous; generator bug fixes require regenerating committed artifacts (spurious diffs); tool ca...

#### CSA-0085 — Security runbook has no "Last Drilled" / quarterly-drill log
_order: 71 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `af7cac03-1204-4de3-968e-be4a249be1c7`_

Layer: DOCS | Severity: MEDIUM | Category: DOCUMENTATION | Action: DOCUMENT | Vision: 6
File/Location: docs/runbooks/security-incident.md
Fix: Add Last Drilled: header; quarterly drill log section (Oct/Jan/Apr/Jul).
Effort: XS | Requires Approval: NO | Source perspectives: 5 | Source IDs: DOC-NEW-0034

#### CSA-0046 — No startup config validation for LOG_LEVEL / CORS_ORIGINS / DATA_DIR write-ability
_order: 70 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `002f2bbf-72c9-4674-9068-939f9c618bee`_

[APPROVED 2026-04-18 — AQ-0016 / Theme C] Approval granted: Portal persistence SQLite → Azure Database for PostgreSQL Flexible Server with managed identity + alembic migrations. Ready for execution.
Layer: OBSERVABILITY | Severity: LOW | Category: BUG | Action: ADD | Vision: 6
File/Location: portal/shared/api/main.py:84-131
Description: Prior OPS-0012 added prod-hard-fails but not these. Fail-at-first-request vs fail-at-startup.
Fix: Assert LOG_LEVEL in standard set; non-empty CORS_ORIGINS in prod; .write-test touch on DATA_DIR.
Effort: S | Requires Approval: NO | Source perspectives: 4 | Source IDs: OPS-NEW-0019

#### CSA-0088 — README "80% coverage gate" vs reality (csa_platform/portal excluded)
_order: 67 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `a88a4c0a-fe1d-4c63-88f1-ddc1dddf87d6`_

Layer: DX | Severity: MEDIUM | Category: DOCUMENTATION | Action: FIX | Vision: 6
File/Location: README.md:148, pyproject.toml:281-323
Description: README claims "80%+ coverage gate." pyproject.toml openly excludes csa_platform/* and portal/shared/api from fail_under.
Fix: Amend README to "80% for governance/domains; csa_platform/portal measured but not gated — see pyproject.toml." OR raise real gate.
Effort: XS | Requires Approval: NO | Source perspectives: 6 | Source IDs: NEW-NEW-0013

#### CSA-0048 — dependabot.yml references removed portal/static-webapp
_order: 66 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `48f92a14-b729-462f-9259-1eba089359d1`_

Layer: CI_CD | Severity: LOW | Category: BUG | Action: FIX | Vision: N/A
File/Location: .github/dependabot.yml:28-33
Description: Static-webapp archived 2026-04-15; dependabot still references path.
Fix: Remove the entry.
Effort: XS | Requires Approval: NO | Source perspectives: 4 | Source IDs: OPS-NEW-0010

#### CSA-0094 — 4-subscription prereq is adoption friction; no "1-sub dev mode" documented
_order: 64 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `cc9cfda0-56d6-43a1-89d2-0e26942dc76c`_

Layer: ONBOARDING | Severity: MEDIUM | Category: DX | Action: DOCUMENT | Vision: 1
File/Location: README.md:167, docs/GETTING_STARTED.md:41-44
Fix: Add "Dev Mode: Single Subscription" doc using management-group segregation; keep 4-sub as prod recommendation.
Effort: M | Requires Approval: NO | Source perspectives: 6 | Source IDs: NEW-NEW-0023

#### CSA-0078 — No Fabric vs CSA OneLake / Direct Lake / Data Activator disambiguation
_order: 63 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `4e102f72-149e-4991-9060-ad7763f2a98e`_

Layer: DOCS | Severity: MEDIUM | Category: DOCUMENTATION | Action: DOCUMENT | Vision: 1
File/Location: csa_platform/onelake_pattern/README.md, docs/PLATFORM_SERVICES.md
Description: "OneLake," "Direct Lake," "Data Activator" refer to both Fabric features and this repo's re-implementations.
Fix: Prefix module references in docs ("CSA OneLake Pattern — ADLS Gen2 emulation of Fabric OneLake"); glossary in PLATFORM_SERVICES.md; consider module renames.
Effort: S | Requires Approval: YES (naming / trademark implications) | Source perspectives: 5 | Source IDs: DOC-NEW-0025

#### CSA-0121 — Dashboard gated by slowest query; no per-section loading; hard-coded "+3 this week"
_order: 62 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `91caa559-71b1-4e39-a051-7070a1a5c0c9`_

Layer: FRONTEND | Severity: MEDIUM | Category: UX/BUG | Action: REFACTOR | Vision: 5
File/Location: portal/react-webapp/src/pages/index.tsx:88-95,132-134,143-145
Description: Stats loading gates entire page. StatCard passes literal change="+3 this week" regardless of actual delta.
Fix: Per-section skeletons instead of global spinner; remove hard-coded change strings OR compute from stats.weekly_deltas backend field.
Effort: S | Requires Approval: NO | Source perspectives: 3 | Source IDs: UX-NEW-0009, UX-NEW-0027

#### CSA-0095 — No "what's in csa_platform vs domains vs governance" overview; naming drift
_order: 61 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `52712979-2c41-445e-9ba2-a4a17e2d5fb1`_

Layer: ONBOARDING | Severity: MEDIUM | Category: DOCUMENTATION | Action: ADD | Vision: 5
File/Location: NEW: docs/REPO_LAYOUT.md
Description: csa_platform/, domains/, governance/, portal/, examples/. No doc explains split. governance/ vs csa_platform/purview_governance/; sharedServices/ vs shared_services/ (camelCase vs snake_case on identical concepts).
Fix: 1-page doc: why each root exists, what goes where, naming rationale.
Effort: S | Requires Approval: NO | Source perspectives: 6 | Source IDs: NEW-NEW-0026

#### CSA-0124 — Misc frontend polish (17 discrete items: line-clamp, ErrorBanner, memoization, toast, skeletons, es5 target, null-guards, mobile, StrictMode)
_order: 60 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `55813948-6c9f-474e-bfa1-a9d6be1d689d`_

Layer: FRONTEND | Severity: LOW-MEDIUM (range) | Category: Mixed (BUG/UX/PERF/A11Y/DOCS) | Action: FIX / REFACTOR / ADD | Vision: 5
File/Location: See individual UX-NEW-XXXX entries in perspective-3-ux.md
Description: Grouped bucket of 17 discrete frontend polish items. Individually low-stakes; collectively defines "enterprise polish":
- UX-NEW-0010 line-clamp plugin; UX-NEW-0013 ErrorBanner align; UX-NEW-0014 Global ErrorBoundary → App Insights; UX-NEW-0015 Layout fragment cleanup; UX-NEW-0016 React.memo on ProductCard; UX-NEW-0017 owner?.team null guard; UX-NEW-0018 Global Toast provider; UX-NEW-0019 Skeleton primitive; UX-NEW-0020 tsconfig target: es2020/esnext; UX-NEW-0022 ApiClient.createAccessRequest signature drift; UX-NEW-0023 Integration test for wizard submission; UX-NEW-0024 aria-hidden Sidebar SVG; UX-NEW-0025 Global useHealth banner; UX-NEW-0026 Marketplace→access flow handoff; UX-NEW-0028 Marketplace freshness sub-hour; UX-NEW-0029 Mobile Playwright coverage; UX-NEW-00...

#### CSA-0103 — No MCP server exposing CSA capabilities
_order: 58 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `d4157f0e-f399-48ea-9648-b00e7eef78e5`_

Layer: COPILOT | Severity: MEDIUM | Category: MISSING_FEATURE | Action: BUILD_NEW | Vision: 7
File/Location: NEW: apps/copilot/mcp_server/
Fix: FastMCP; expose csa.search, csa.walk_decision_tree, csa.lookup_runbook, csa.dry_run_deploy.
Effort: M | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0011 | Deps: CSA-0008

#### CSA-0106 — Async credential cleanup leak in EmbeddingGenerator
_order: 57 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `0f6cfd6b-8805-405a-baa1-cf58fa856455`_

Layer: AI | Severity: MEDIUM | Category: DESIGN_FLAW | Action: REFACTOR | Vision: 7
File/Location: csa_platform/ai_integration/rag/pipeline.py:332
Fix: async def aclose(); wire FastAPI shutdown event; or contextvar-scoped credential.
Effort: S | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0016

#### CSA-0107 — RAG pipeline lacks retry / circuit breaker / fallback on Azure OpenAI
_order: 55 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `7fd21b82-8c63-4261-a8bc-d1980ec9d4e9`_

Layer: AI | Severity: MEDIUM | Category: MISSING_FEATURE | Action: ADD | Vision: 7
File/Location: csa_platform/ai_integration/rag/pipeline.py:RAGPipeline.query
Fix: tenacity exponential+jitter; pybreaker circuit breaker; optional fallback to gpt-4o-mini after N failures.
Effort: S | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0017

#### CSA-0055 — Helm AKS deploy lacks helm lint, helm diff, --atomic
_order: 54 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `bd1ac234-1bdf-45b3-9d6b-476b989000ee`_

Layer: CI_CD | Severity: LOW | Category: BUG | Action: FIX | Vision: 6
File/Location: .github/workflows/deploy-portal.yml:167-176
Fix: Add helm lint before deploy; helm diff upgrade preview; --atomic rollback on failure.
Effort: XS | Requires Approval: NO | Source perspectives: 4 | Source IDs: OPS-NEW-0017 | Deps: CSA-0053

#### CSA-0108 — _rate_limit in classifier blocks event loop in async contexts
_order: 53 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `32dba378-9e96-445d-abf1-2117b6cdb6db`_

Layer: AI | Severity: MEDIUM | Category: DESIGN_FLAW | Action: REFACTOR | Vision: 7
File/Location: csa_platform/ai_integration/enrichment/document_classifier.py:251-277
Fix: _rate_limit_async with asyncio.sleep; classify_async / classify_records_async; aiolimiter token bucket.
Effort: S | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0018

#### CSA-0134 — portal/cli/ duplicates React portal commands; architecturally a protocol adapter, not 4th portal
_order: 52 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `6856d9dc-98e2-4345-8872-86c0347e892e`_

[APPROVED 2026-04-18 — AQ-0031 / Theme E] Approval granted: git filter-repo to purge tools/dbt/dbt-env/ venv and sibling .venv/ blobs from history. Schedule maintenance window; notify all contributors before force-push. Ready for execution.
Layer: ARCHITECTURE | Severity: MEDIUM | Category: DESIGN_FLAW | Action: REFACTOR | Vision: 5
File/Location: portal/cli/__main__.py, portal/cli/client.py, portal/cli/commands/{marketplace,pipelines,sources,stats}.py; portal/react-webapp/, portal/powerapps/, portal/kubernetes/ (other three variants); Recent commit 0dcd5f8 adds CLI as "4th portal variant"
Description: CLI structured as peer to React/PowerApps/Kubernetes portals, but architecturally it is API client, not portal. Commands mirror React pages with click commands hitting same /api/v1/* endpoints. "Portal variant" label distorts architecture diagram — portals imply distinct user experience; CLI is protocol adapter. Re-implementing what httpie or generated OpenAPI client could do. PowerAp...

#### CSA-0115 — No end-to-end ML example (train → register → deploy → invoke)
_order: 47 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `c96a2232-c5bd-4193-a0fb-1f8c1bbe6887`_

Layer: AI | Severity: MEDIUM | Category: MISSING_FEATURE | Action: ADD | Vision: 7
File/Location: NEW: examples/ml-end-to-end/
Fix: USDA crop-yield train → MLflow register → deploy via ModelEndpoint.deploy() → invoke from Function → write to Silver.
Effort: M | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0029

#### CSA-0110 — RAG query_async wraps sync code in thread pool — defeats async
_order: 46 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `5ce865fe-dab8-4baf-a74a-0156963dcd52`_

Layer: AI | Severity: MEDIUM | Category: DESIGN_FLAW | Action: REFACTOR | Vision: 7
File/Location: csa_platform/ai_integration/rag/pipeline.py:902-925
Fix: True async with AsyncAzureOpenAI and async Search client.
Effort: M | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0020

#### CSA-0116 — No conversation memory / session state for Copilot
_order: 45 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `c81591f1-6d5e-484e-bd33-d47eeebb9604`_

Layer: COPILOT | Severity: MEDIUM | Category: MISSING_FEATURE | Action: BUILD_NEW | Vision: 7
File/Location: NEW: apps/copilot/memory/
Fix: Cosmos session store keyed on (tenant_id, user_id, thread_id); sliding window + summarization; /clear action.
Effort: M | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0026 | Deps: CSA-0008

#### CSA-0056 — make lint-bicep uses GNU find + sh -c; fails on Windows PowerShell
_order: 44 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `ba42f4b9-2f5b-406f-9deb-63ebe2792c6b`_

Layer: DX | Severity: LOW | Category: DX | Action: REFACTOR | Vision: 6
File/Location: Makefile:52-53
Fix: Cross-platform Python script or PowerShell equivalent.
Effort: S | Requires Approval: NO | Source perspectives: 4 | Source IDs: OPS-NEW-0020

#### CSA-0111 — No prompt versioning / A/B framework
_order: 43 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `8a8c5550-abdf-4f34-94de-dc85d6f97fff`_

Layer: AI | Severity: MEDIUM | Category: MISSING_FEATURE | Action: BUILD_NEW | Vision: 7
File/Location: NEW: apps/copilot/prompts/
Fix: Externalize prompts to versioned files; prompt manifest with semver; record prompt_version in audit log; integrate with eval harness.
Effort: M | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0021 | Deps: CSA-0023

#### CSA-0113 — No Fabric Data Agent / Fabric ML representation
_order: 41 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `52a34508-06d2-44b6-8b31-45ce2065b9c5`_

Layer: AI | Severity: MEDIUM | Category: MISSING_FEATURE | Action: ADD | Vision: 7
File/Location: NEW: examples/fabric-ai/, docs/FABRIC_AI.md
Fix: Fabric Data Agent example (T-SQL endpoint + agent); Fabric ML notebook; positioning of Fabric AI vs Databricks AI.
Effort: L | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW-0023 | Deps: CSA-0063

### status: done (34)

#### Complete Multi-Synapse workspace isolation and federation
_order: 112 . feature: phase-1-platform . assignee: User . id: `a99a68ea-f55d-467d-a8ec-215bda43d1fe`_

ALREADY COMPLETE: 1,518 lines (workspace_manager.py, cost_allocator.py, cross_workspace_query.py) + 598 lines of tests. Full workspace lifecycle, cost allocation, federated queries. Verified 2026-04-17.

#### dbt silver/gold DuckDB compat — complete CI integration tests
_order: 109 . feature: dbt . assignee: User . id: `c3223f5f-2b38-4414-ae3a-7bd5596485b4`_

Bronze layer passes DuckDB CI (7/12 models). Silver/gold/snapshot models still use Spark-specific SQL (window functions, complex CTEs, SCD2 merge patterns) that DuckDB can't execute. Need to: (1) audit remaining 5 failing models for Spark-only constructs, (2) extend the compat.sql macros or add conditional model configs, (3) target 12/12 models passing in CI. PR #56 laid the foundation.

#### Build AI RAG pipeline and model serving infrastructure
_order: 108 . feature: phase-1-platform . assignee: User . id: `04748f88-72b8-4400-a85a-669b724d8469`_

Complete the AI integration with full RAG pipeline (embeddings, similarity search), document enrichment at scale, and model serving. Currently has framework stubs.

Completion criteria:
- Embedding generation pipeline (Azure OpenAI / local models)
- Vector store integration for similarity search
- Document enrichment pipeline at scale
- Model serving infrastructure with versioning
- RAG query API with citation support
- Performance benchmarks and scaling tests

Files: csa_platform/ai_integration/

#### P1: Extract shared domain scoping dependency (ARCH-0006, SEC-0009)
_order: 107 . feature: Security . assignee: Coding Agent . id: `3e905268-2e62-422f-80c9-7ed95f71f28b`_

Domain-based authorization is copy-pasted across 4 routers (sources, marketplace, pipelines, access). Each independently extracts roles, domain claim, checks Admin. Pipeline GET endpoints (SEC-0009) lack domain scoping entirely.

Fix: Create DomainScope dependency in services/auth.py:
  class DomainScope: user_domain: str | None; is_admin: bool
  def get_domain_scope(user=Depends(get_current_user)) -> DomainScope
  def assert_domain_access(scope: DomainScope, target_domain: str)

Then inject DomainScope in all routers and add domain checks to pipeline GET/GET-runs endpoints.

Files: portal/shared/api/services/auth.py, all 4 routers, portal/shared/api/routers/pipelines.py (get_pipeline, get_pipeline_runs)

Completion: Domain scoping uses single shared implementation. Pipeline GET endpoints enforce domain access. All tests pass including new domain scoping tests.

#### P1: Harden health endpoint + demo mode scoping (SEC-0004, SEC-0005)
_order: 105 . feature: Security . assignee: Coding Agent . id: `7f0368e2-2302-458a-b1f9-64b27c0353e1`_

1. SEC-0004: /api/v1/health leaks version, environment, auth_configured status to unauthenticated callers. Strip sensitive fields from public response or gate detailed response behind auth.

2. SEC-0005: In demo mode, synthetic user has no domain claim. In list_sources/list_products, no domain = no filtering, giving demo Reader access to ALL domains. Add guard: if not Admin and no domain claim, return empty results (or assign a default demo domain).

Files: portal/shared/api/main.py (health_ready), portal/shared/api/routers/sources.py, marketplace.py, pipelines.py

Completion: Health endpoint returns only status+timestamp publicly. Demo user has restricted scope. Tests cover both scenarios.

#### P1: Add startup config validation for production (OPS-0012)
_order: 103 . feature: Security . assignee: Coding Agent . id: `86d699db-9d63-46ec-b9af-2842963c953f`_

All Azure resource settings (STORAGE_ACCOUNT_NAME, ADF_RESOURCE_GROUP, ADF_FACTORY_NAME, PURVIEW_ACCOUNT_NAME) default to empty strings. App appears healthy but fails at runtime when users attempt operations requiring Azure services.

Fix: Add startup validator in the lifespan handler that checks required settings based on ENVIRONMENT. If ENVIRONMENT=production and critical Azure settings are empty, raise RuntimeError (similar to auth safety gate pattern).

File: portal/shared/api/main.py (lifespan), portal/shared/api/config.py

Completion: Production deployments with missing config fail fast at startup. Local/demo mode unaffected. Tests cover both paths.

#### P1: Pin Docker images to SHA256 digests (OPS-0001)
_order: 101 . feature: Security . assignee: Coding Agent . id: `2c52127d-a97d-4624-be29-07d65487ac54`_

Base images (python:3.12-slim, node:20-alpine, nginx:1.27-alpine, redis:7-alpine) are not pinned to digests. Floating tags = supply chain risk + non-reproducible builds.

Fix: Pin all Dockerfiles and docker-compose to SHA256 digests. Add comment with human-readable tag for maintainability.

Files: portal/shared/Dockerfile, portal/kubernetes/docker/backend/Dockerfile, portal/kubernetes/docker/frontend/Dockerfile, portal/kubernetes/docker/docker-compose.yml

Completion: All images pinned. Builds reproducible. Document digest rotation process.

#### Implement Direct Lake automation and semantic model tooling
_order: 100 . feature: phase-1-platform . assignee: User . id: `bda52d7d-b611-4977-8a19-9ac0ce62ee91`_

ALREADY COMPLETE: 1,016 lines of implementation (configure_sql_endpoint.py, generate_semantic_model.py) + 558 lines of tests. Full Databricks SQL endpoint management and Power BI semantic model generation. Verified 2026-04-17.

#### P1: Fix auth auto_error + bearer scheme defense (SEC-0010)
_order: 99 . feature: Security . assignee: Coding Agent . id: `2a4823d6-85fb-4c12-8f56-fe25eea34f51`_

bearer_scheme uses auto_error=False, meaning missing Authorization headers don't auto-return 401. Any new endpoint added without Depends(get_current_user) silently accepts unauthenticated requests.

Fix: Either switch to auto_error=True (handling demo mode via middleware), or add a startup check that verifies all routes have auth dependencies.

File: portal/shared/api/services/auth.py (re-export), csa_platform/common/auth.py

Completion: New endpoints without auth are caught either at startup or by auto_error. Tests verify behavior.

#### P2: Improve SqliteStore — connection pooling + query() (ARCH-0007, DX-0006, DX-0007)
_order: 92 . feature: Architecture . assignee: Coding Agent . id: `559a4e1c-49d7-42eb-bc1e-dacf12ab8785`_

Three related persistence layer improvements:

1. DX-0006: SqliteStore opens a new sqlite3 connection per operation with 3 PRAGMA calls each time. Use a cached per-thread connection or connection pool. Set PRAGMAs once.

2. DX-0007: query() loads ALL items into Python then filters with str()==str(). Use SQLite json_extract() in WHERE clause for server-side filtering. Remove str() coercion that silently matches 0=="0".

3. ARCH-0007: No schema enforcement at DB level. Add json_valid() CHECK constraint.

File: portal/shared/api/persistence.py

Completion: Connection reuse verified (no per-call overhead). query() uses SQL-level filtering. Type-sensitive comparisons. All tests pass.

#### Build automated data classification with Purview ML
_order: 91 . feature: phase-2-governance . assignee: User . id: `017f430c-b7fc-4d7d-aead-92b473884593`_

ALREADY COMPLETE: 1,341 lines (purview_automation.py, sharing_enforcer.py) + 679 lines of tests. Classification rules, glossary, lineage, sensitivity labels, sharing enforcement. Verified 2026-04-17.

#### P2: Extract stats service layer (ARCH-0005)
_order: 90 . feature: Architecture . assignee: Coding Agent . id: `98ef2484-6dc7-4d26-8c68-97de1bccbf94`_

Stats router reaches into private _sources_store, _pipelines_store, _runs_store, _products_store, _access_store from sibling routers via lazy imports. Tight coupling on internal implementation details.

Fix: Create portal/shared/api/services/stats_service.py that accepts stores as dependencies. Each router exposes its store via public accessor. Stats router/service queries through public interface.

Also move the /api/v1/domains endpoint logic from main.py into the stats router.

Files: portal/shared/api/routers/stats.py, portal/shared/api/main.py, new services/stats_service.py

Completion: Stats module doesn't import private store vars. Can be tested in isolation. All tests pass.

#### P2: Fix provisioning service mutation pattern (ARCH-0011)
_order: 88 . feature: Architecture . assignee: Coding Agent . id: `4e1ddab6-aadd-4613-93ab-d371df93dd56`_

portal/shared/api/services/provisioning.py mutates the SourceRecord object passed to it (status, pipeline_id, purview_scan_id, updated_at). Caller must persist mutations. If persist fails, in-memory state diverges from DB. Service also catches all exceptions silently.

Fix: Service should return a ProvisioningResult containing NEW values without mutating input. Router applies result to record and persists. Make data flow explicit and unidirectional. Re-raise or log exceptions with correlation context.

Files: portal/shared/api/services/provisioning.py, portal/shared/api/routers/sources.py

Completion: No mutation-at-distance. Error handling explicit. Tests cover success + failure paths.

#### Frontend: global error boundary + mutation feedback + performance
_order: 87 . feature: frontend . assignee: User . id: `dfe2742b-ba20-4dc9-8279-2d400fa022a5`_

Audit items #18-20. React portal (portal/react-webapp) has: (1) No global error boundary — crashes produce white screens. (2) Mutations (useRegisterSource, useProvisionSource) fire-and-forget with zero toast/alert feedback. (3) No code splitting — Recharts (~400KB) loaded eagerly on dashboard. (4) Registration wizard has no per-step validation (zod is a dep but unused). (5) Sources page duplicates StatusBadge/DataTable/PageHeader instead of using shared components. Fix priority: error boundary + toasts first, then lazy-load + validation, then component dedup.

#### P2: Extract shared Azure Functions utilities (ARCH-0012)
_order: 86 . feature: Architecture . assignee: Coding Agent . id: `509f5f84-fb33-47c1-8aa8-d30c1f962912`_

Three Azure Functions (aiEnrichment, eventProcessing, secretRotation) share identical patterns implemented independently: health check endpoint, logging setup, trace context binding, JSON error responses, blob size constants.

Fix: Create domains/sharedServices/common/ with:
- function_helpers.py: standard health check builder, JSON response helpers, trace context wrapper
- constants.py: shared limits (MAX_BLOB_SIZE etc.)

Update all three function apps to use shared utilities.

Completion: Health check schema identical across services. No duplicated utility code. All function tests pass.

#### P2: Deployment fixes — Helm tags, health paths, ArgoCD, Checkov (OPS-0008, OPS-0013, OPS-0016, OPS-0017, OPS-0018)
_order: 84 . feature: Infrastructure . assignee: Coding Agent . id: `13d23d01-f406-454e-b83a-682f1b0ab50e`_

Five deployment config issues:

1. OPS-0008: CI tags images with SHA but Helm defaults to 0.1.0 with pullPolicy:Always. Fix: pullPolicy to IfNotPresent, stop pushing latest, default tag to Chart.AppVersion.

2. OPS-0013: Health check path mismatch — Dockerfile uses /api/health, Helm uses /api/v1/health. Standardize on /api/v1/health everywhere. Separate liveness from readiness.

3. OPS-0016: ArgoCD application.yaml has placeholder repoURL. Update or templatize.

4. OPS-0017: Helm values.yaml has placeholder domain. Add required check in templates.

5. OPS-0018: Checkov runs soft_fail:true — security violations never block. Change to false, use --skip-check for accepted risks.

Completion: Helm chart deploys with correct image tags. Health checks consistent. Checkov enforced. ArgoCD config valid.

#### Implement autonomous data onboarding pipeline
_order: 83 . feature: phase-2-governance . assignee: User . id: `b4b7a90a-5013-4294-a7fe-b1e3e1867172`_

End-to-end self-service data onboarding: automatic DLZ provisioning, schema inference and curation, intelligent source-to-target mapping, and automated quality rule generation.

Completion criteria:
- Automatic Data Landing Zone (DLZ) provisioning on onboarding request
- Schema inference from source systems (structured + semi-structured)
- Schema curation workflow with domain owner approval
- Intelligent source-to-target mapping with suggestions
- Automated quality rule generation based on inferred schema
- Self-service onboarding UI integration
- End-to-end onboarding workflow tests

Files: csa_platform/metadata_framework/

#### CSA-0133 — Routers bypass service layer; persistence + business logic + HTTP serialization in one file
_order: 83 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `ce3abd0f-4869-40ea-a2fe-0ae45fe7f640`_

[IN PROGRESS 2026-04-20 by session Claude Opus 4.7 (1M context)] Shipped the RAG-async portion of the approved AQ-0020 scope. csa_platform/ai_integration/rag/pipeline.py: dropped run_in_executor fake-async wrapper; VectorStore.search_async uses azure.search.documents.aio.SearchClient with async iteration (enables streaming pagination); RAGPipeline async chat path uses openai.AsyncAzureOpenAI; per-instance async-client caching + idempotent aclose() on both classes; azure.identity.aio.DefaultAzureCredential for AAD. 8 new tests including concurrency proof (5 concurrent calls overlap and finish under serial bound). csa_platform suite 433/433 green. Commit 90826ca.

Remaining scope for this CSA ID:
  * Split RAG monolith (currently rag/pipeline.py) into indexer/retriever/rerank/generate submodules — not started.
  * Service-layer extraction for portal routers (marketplace/pipelines/sources/access) to stop routers bypassing it with module-level SqliteStore wiring + inline business logic ...

#### P2: Add PodDisruptionBudgets + graceful shutdown (OPS-0005, OPS-0014)
_order: 82 . feature: Infrastructure . assignee: Coding Agent . id: `aaa8f39e-4001-41a9-a629-ea951ed090fd`_

1. OPS-0005: No PDBs defined despite HPA scaling 2-10 replicas. During node drains all pods could be evicted simultaneously. Add PDB templates with minAvailable:1.

2. OPS-0014: No graceful shutdown. Configure uvicorn --timeout-graceful-shutdown 30, ensure K8s terminationGracePeriodSeconds > 30.

Files: portal/kubernetes/helm/csa-portal/templates/ (new pdb.yaml), values.yaml, backend.yaml

Completion: PDBs prevent simultaneous eviction. Graceful shutdown configured. In-flight requests complete during deploys.

#### P2: Add portal Makefile targets (OPS-0015)
_order: 80 . feature: DX-Quick-Wins . assignee: Coding Agent . id: `d1ae2926-8e7c-4212-9c71-c8712f38ae61`_

No portal-specific Makefile targets. Portal devs must manually navigate directories.

Add to Makefile:
- portal-dev: start backend + frontend for local development
- portal-test: run portal backend + frontend tests
- portal-docker: docker compose up for containerized dev
- portal-lint: lint portal Python + TypeScript

File: Makefile

Completion: make portal-dev starts full local dev stack. make portal-test runs all portal tests.

#### P3: Frontend accessibility fixes (FE-0010 to FE-0013, FE-0024)
_order: 75 . feature: Frontend . assignee: Coding Agent . id: `1e50a38d-8a76-4c19-9d4c-3740d4f01950`_

Five accessibility violations (WCAG 2.1 AA):

1. FE-0010: Registration wizard form inputs missing htmlFor/id associations across all step components (StepConnection, StepIngestion, StepSchema, StepQuality). Screen readers can't associate labels.

2. FE-0011: Sources page filter inputs lack labels. Text input uses placeholder only.

3. FE-0012: Marketplace page search/select filters lack label associations.

4. FE-0013: Source table rows have cursor-pointer but only name cell is a Link. Row isn't clickable. Either make row clickable or remove cursor-pointer.

5. FE-0024: Mobile sidebar overlay has onClick but no Escape key handler. Keyboard users trapped.

Files: src/components/register/Step*.tsx, src/pages/sources/index.tsx, src/pages/marketplace/index.tsx, src/components/Sidebar.tsx

Completion: All interactive elements have proper labels/ARIA. Keyboard navigation works. Playwright visual verification.

#### P3: Frontend UX fixes — debounce, error banners, validation (FE-0008, FE-0009, FE-0015, FE-0016, FE-0021, FE-0022, FE-0023)
_order: 73 . feature: Frontend . assignee: Coding Agent . id: `bd17e068-c1e6-4e35-b88e-0a617343a304`_

Seven frontend UX issues:

1. FE-0015/0016: Search/filter inputs trigger API on every keystroke. Add useDebounce (300-500ms) before passing to hooks.

2. FE-0009: ErrorBanner copy-pasted across 3 pages. Extract shared component.

3. FE-0008: Quality rules dual-state (useState + react-hook-form). Use useFieldArray.

4. FE-0021: validateStep validates fields for wrong source type. Add conditional logic based on selected sourceType.

5. FE-0022: Tags default to [] but type is Record<string,string>. Fix to {}.

6. FE-0023: Registration form has no owner info step. Either add wizard step or auto-populate from MSAL profile.

Files: src/pages/sources/index.tsx, src/pages/marketplace/index.tsx, src/pages/sources/register.tsx, src/components/register/*, new src/components/ErrorBanner.tsx

Completion: No flickering on search. Forms validate correctly per source type. Owner populated. Tests cover happy path.

#### P3: Fix registration wizard schema type mismatch (FE-0002)
_order: 71 . feature: Frontend . assignee: Coding Agent . id: `911b9f01-a0cd-4bad-9162-dd7cb5147192`_

Registration form uses fields auto_detect, _table_name, _primary_key_csv which don't exist on SchemaDefinition type (has columns, primary_key, partition_columns, watermark_column). Form submits unrecognized fields.

Fix: Either update SchemaDefinition type to include these fields (matching Python model), or transform form data before submission to map into the correct shape.

Files: src/components/register/StepSchema.tsx, portal/shared/contracts/types.ts, portal/shared/api/models/source.py

Completion: Schema step submits valid data matching backend model. Type contract aligned between frontend and backend.

#### Build FinOps dashboards and cost allocation by domain
_order: 70 . feature: phase-3-observability . assignee: User . id: `dbfd6985-3b4f-4866-9c56-efffa12ff116`_

ALREADY COMPLETE: Monitoring is infrastructure-as-code by design. Bicep alert templates (budget, data quality, Databricks, Key Vault, pipeline, storage) + 3 Grafana JSON dashboards (data_quality, infrastructure, pipeline_health). No Python code needed. Verified 2026-04-17.

#### P3: Frontend test coverage expansion (FE-0017, FE-0018)
_order: 69 . feature: Testing . assignee: Coding Agent . id: `e1adf0cc-ac36-481e-a90c-56a6a2407653`_

Only 2 test files exist (Button.test.tsx, index.test.tsx). Zero coverage for: registration wizard, marketplace page, access requests, Layout/Sidebar, DataTable, Modal, StatusBadge, all 6 registration steps, useApi hooks, API client.

Priority test targets:
1. Registration wizard step navigation + validation (most complex flow)
2. useApi hooks with mocked API responses
3. DataTable sorting/pagination
4. Error states on all pages (loading, error, empty)
5. Dashboard loading/error/empty states (FE-0018)

Files: portal/react-webapp/__tests__/ (new test files)

Completion: Critical user flows tested. Coverage includes loading/error/empty states. All Jest tests pass.

#### P3: Rename tests/e2e to tests/integration + fix test quality (DX-0011, DX-0012, DX-0013, DX-0014, DX-0015, SEC-0008)
_order: 67 . feature: Testing . assignee: Coding Agent . id: `237b2024-a3da-4f56-b8b7-c3b522aa7e52`_

Six test quality issues:

1. DX-0012: tests/e2e/ tests are not truly E2E — they validate static structure and in-memory DuckDB. Rename to tests/integration/.

2. DX-0011: Concurrency tests don't test real concurrency (just asyncio.sleep). Either test real enrichment or rename tests.

3. DX-0013: test_event_type_is_known uses random.choice — test all event types instead.

4. DX-0014: 6 streaming tests silently skip if adx_setup.kql missing. Add assertion for file existence.

5. DX-0015: Coverage enforcement excludes csa_platform/ and portal/. Set lower threshold (50%) and ratchet up.

6. SEC-0008: Test files use hardcoded "key123" strings. Use named constants.

Files: tests/e2e/ (rename), tests/functions/test_concurrency.py, tests/e2e/test_e2e_streaming.py, pyproject.toml, Makefile

Completion: Test directory correctly named. Coverage enforced more broadly. No silent skips. Tests pass.

#### P3: Marketplace model consolidation — Phase 1 (ARCH-0001)
_order: 65 . feature: Architecture . assignee: Coding Agent . id: `0906d562-270e-4af7-b95d-d6a1d6c030e5`_

Portal and csa_platform have divergent marketplace implementations. The 4-step consolidation plan is documented in csa_platform/data_marketplace/api/marketplace_api.py.

Phase 1 (this task): Adopt the richer domain models from csa_platform into portal models.
- Add SLADefinition, LineageInfo, DataProductSchema concepts to portal's marketplace models
- Create response DTO adapters so the React frontend type contract is preserved (backward compat)
- Update portal/shared/contracts/types.ts to match new model
- Migrate portal's flat quality_score:float to dimensioned QualityScore

This is the foundation. Phase 2 (separate task) would wire the platform marketplace to use portal's store.

Files: portal/shared/api/models/marketplace.py, csa_platform/data_marketplace/models/data_product.py, portal/shared/contracts/types.ts

Completion: Portal marketplace models have schema/SLA/lineage fields. Existing API contract preserved via DTOs. All tests pass.

#### Implement real-time data quality monitoring
_order: 63 . feature: phase-3-observability . assignee: User . id: `60f5a415-b1b3-412a-9ebc-19a525bc4736`_

Streaming quality checks, automated SLA breach notifications, quality trend analysis, and root cause analysis for quality failures.

Completion criteria:
- Streaming data quality checks on ingestion pipelines
- Automated SLA breach detection and notifications
- Quality trend analysis dashboards (completeness, accuracy, timeliness)
- Root cause analysis tooling for quality failures
- Quality scorecards per data domain
- Integration with alerting infrastructure (Teams, email, PagerDuty)

Files: governance/, csa_platform/

#### Build Cloud Shell / CLI portal implementation
_order: 55 . feature: phase-4-portal . assignee: User . id: `07a7c326-7b45-4e95-80e6-51094efebe0c`_

Create the 4th portal variant as a CLI/Cloud Shell experience for platform engineers. The existing 3 portals are: PowerApps, React/Next.js, and Kubernetes/AKS.

Completion criteria:
- CLI tool scaffolding with command structure (e.g., csa-cli)
- Core commands: workspace create/list/delete, data onboard, governance check
- Cloud Shell compatibility (Azure Cloud Shell, local terminal)
- Authentication integration (Azure AD / Entra ID)
- Interactive and non-interactive modes
- Output formats: table, JSON, YAML
- Shell completions (bash, zsh, PowerShell)
- Integration with existing CSA platform APIs
- Documentation and quick-start guide

Files: portal/

#### Consolidate configuration on Pydantic Settings universally
_order: 51 . feature: architecture . assignee: User . id: `16539209-31af-4d81-bec9-ad5e20cbc9de`_

Audit item #21. Config is scattered: pyproject.toml (Python), agent-harness/config.yaml, csa_platform/onelake_pattern/onelake_config.yaml, csa_platform/direct_lake/semantic_model_template.yaml, governance/dataquality/quality-rules.yaml, portal/shared/api/config.py (Pydantic Settings), multiple params.*.json for Bicep, .env.example. Portal already uses Pydantic Settings (good pattern). Create a csa_platform/config.py base that loads from env vars with YAML fallback. Eliminate ad-hoc yaml.safe_load scattered across modules.

#### Azure SDK client factory — eliminate copy-paste across csa_platform modules
_order: 40 . feature: architecture . assignee: User . id: `c1827557-2aa4-4990-9e7a-33834b06d1f2`_

Audit item #19. Azure SDK client initialization (DefaultAzureCredential + specific client construction) is repeated across every csa_platform module: ai_integration, data_activator, data_marketplace, direct_lake, multi_synapse, onelake_pattern, purview_governance, shared_services. Create a shared csa_platform/common/azure_clients.py factory that centralizes credential management, connection pooling patterns, and retry configuration. Pattern: factory functions like get_blob_client(), get_cosmos_client(), get_keyvault_client() that use DefaultAzureCredential with proper async context management.

#### CSA-0125 — Azure OpenAI usage present but no Assistants API / Batch / on-your-data / fine-tune
_order: 20 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `83631b1f-2e94-4a4c-ad53-6a4c8acf02b8`_

Layer: AI | Severity: LOW | Category: MISSING_FEATURE | Action: DOCUMENT | Vision: 7
File/Location: csa_platform/ai_integration/ and docs
Description: Coverage matrix: Azure OpenAI is "PRESENT" for embeddings + chat only. No Assistants API, no batch API, no on-your-data, no fine-tune. Document scope explicitly.
Fix: Capability matrix in ai_integration/README.md enumerating which AOAI features are in-scope vs out-of-scope; align with CSA-0114.
Effort: XS | Requires Approval: NO | Source perspectives: 7 | Source IDs: AI-NEW (implicit) | Deps: CSA-0114

#### CSA-0093 — examples/cybersecurity/ missing (#1 federal analytics use case)
_order: 18 . feature: CSA-INABOX-AUDIT-2026-04-18 . assignee: User . id: `ff8c2a16-931f-46cd-81d5-bba3d3ed12c4`_

[APPROVED 2026-04-18 — AQ-0011 / Theme B] Approval granted: Build examples/cybersecurity/ vertical (Sentinel → ADLS Bronze → MITRE ATT&CK Silver → threat-hunting Gold + KQL dashboards) after iot-streaming dbt completion. Ready for execution.
Layer: FEDERAL | Severity: LOW (discovery) / strategic gap | Category: VISION_GAP | Action: DOCUMENT (decision); BUILD_NEW (implementation) | Vision: 5
File/Location: N/A
Description: Cybersec is top federal analytics use case; no SIEM/SOAR/MITRE ATT&CK/CISA KEV vertical.
Fix: Add examples/cybersecurity/: Sentinel → ADLS Bronze → MITRE Silver → threat-hunting Gold + KQL dashboards.
Effort: XL | Requires Approval: YES | Source perspectives: 6 | Source IDs: NEW-NEW-0022

#### Complete comprehensive data engineering audit
_order: 0 . assignee: Archon . id: `89e17588-365b-4159-9b4d-4d7882033241`_

Full-repo audit completed 2026-04-16. Covered backend, security, frontend, DevOps, cross-cutting concerns across 5 parallel audit agents. Found 25 items across 4 severity tiers. 14 items shipped in PRs #37, #52-58. See session summary for full findings.

---
