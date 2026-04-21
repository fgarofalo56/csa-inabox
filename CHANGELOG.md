# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is maintained automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/). See
[RELEASE.md](RELEASE.md) for the release process.

## [0.1.0] - 2026-04-20

Initial internal release of csa-inabox — Azure-native reference
implementation of Microsoft's "Unify your data platform" guidance.

### Features

- Reference architectures for Fabric-parity on Azure PaaS (DMLZ +
  DLZ landing zones, medallion Delta Lake, streaming via Event Hubs
  + ADX, AI/ML via Azure OpenAI + Azure ML).
- 10 vertical examples (finance, sales, inventory, commerce, DOT,
  USDA, USPS, NOAA, EPA, Interior, tribal health, casino).
- Audit-remediation branch: 38+ CSA findings resolved spanning
  auth safety gates, JWT hardening, tamper-evident audit log,
  compliance matrices (NIST 800-53, CMMC 2.0 L2, HIPAA), Palantir +
  Snowflake + AWS + GCP migration playbooks, 8 decision trees, 11
  MADR ADRs, governance + shared-services consolidation, CLI
  promotion, IoT Entra-only, canonical DLQ pattern, and more.
- Dependabot configuration for pip and GitHub Actions.
- CodeQL SAST analysis workflow.
- NSG outbound security rules for all subnet types.
- Blob size limits and input validation in Function Apps.
- Connection pooling for AI enrichment clients.
- UUID-based event ID generation (replacing datetime-based).
- Load test baselines directory structure.
- DEPRECATED.md for ARM templates migration guide.

### Bug Fixes

- Fixed `gld_inventory_turnover` SQL syntax error (duplicate
  SELECT, stray parenthesis).
- Fixed non-existent `safety_stock` column reference in inventory
  turnover model.
- Removed hardcoded subscription IDs, IPs, and PII from ALZ
  parameter files.
- Added deployment guard to DLZ external storage module.
- Fixed DMLZ governance property name mismatches preventing
  deployment.
- Added Azure SDK retry logic to all Function Apps (secret
  rotation, AI enrichment, event processing).
- Fixed broken dbt incremental strategies in gold models.
- Fixed dbt schema test column name mismatches.
- Added source freshness checks to inventory and sales domains.
- Fixed CI/CD workflow bugs (secret names, timeouts, error
  handling).
- Fixed Bicep typos (Postgres DNS zone, "requirments",
  "Moddules").
- Fixed `privatelink.bicep` always-true logic bug.
- Fixed DLZ storage modules missing monitoring and CMK parameter
  pass-through.

### Code Refactoring

- Standardized dbt metadata columns to `_dbt_run_id`.
- Moved SHIR VM auth key to `protectedSettings`.
- Changed OpenLineage auth from API key to OAuth / managed
  identity.
- Changed Cosmos DB `disableKeyBasedMetadataWriteAccess` default to
  `true`.
- Parameterized ALZ tags (PrimaryContact, CostCenter).
- Parameterized ALZ storage IP rules.
- Improved PII redaction to use service's built-in `redacted_text`.
- Added type hints and docstrings to Python modules.
- Added encryption at host for SHIR VM.
- Added CMK parameter pass-through in lake zone storage.
- Added outbound NSG deny-all rules with service tag exceptions.

### Documentation

- 11 MADR architectural decision records.
- 8 mermaid + YAML decision trees with Copilot `walk_tree` contract.
- 4 migration playbooks (Palantir Foundry, Snowflake, AWS, GCP).
- 3 compliance framework control matrices (NIST 800-53 Rev 5, CMMC
  2.0 L2, HIPAA Security Rule) with 304 controls / 231 evidence
  items, validator script.
- Operator runbooks: DR drill, dead-letter, security-incident,
  rollback, troubleshooting.

### Tests

- 978+ passing tests across `csa_platform` / portal / CLI /
  governance / functions suites.
- Zero regressions across ~62 commits of audit remediation.

## [Unreleased]

<!-- release-please maintains this section automatically as
conventional-commit PRs land on main -->

---

## Related Documentation

| Document | Description |
|---|---|
| [README](README.md) | Project overview and quick start |
| [CONTRIBUTING](CONTRIBUTING.md) | Development guidelines and PR process |
| [RELEASE](RELEASE.md) | Release process and Conventional Commits reference |
