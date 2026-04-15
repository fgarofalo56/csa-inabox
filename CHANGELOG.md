# Changelog

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Developers / Contributors

All notable changes to the CSA-in-a-Box project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Fixed gld_inventory_turnover SQL syntax error (duplicate SELECT, stray parenthesis)
- Fixed non-existent safety_stock column reference in inventory turnover model
- Removed hardcoded subscription IDs, IPs, and PII from ALZ parameter files
- Added deployment guard to DLZ external storage module
- Fixed DMLZ governance property name mismatches preventing deployment
- Added Azure SDK retry logic to all Function Apps (secret rotation, AI enrichment, event processing)
- Fixed broken dbt incremental strategies in gold models
- Fixed dbt schema test column name mismatches
- Added source freshness checks to inventory and sales domains
- Fixed CI/CD workflow bugs (secret names, timeouts, error handling)
- Fixed Bicep typos (Postgres DNS zone, "requirments", "Moddules")
- Fixed privatelink.bicep always-true logic bug
- Fixed DLZ storage modules missing monitoring and CMK parameter pass-through

### Added
- Dependabot configuration for pip and GitHub Actions
- CodeQL SAST analysis workflow
- NSG outbound security rules for all subnet types
- Blob size limits and input validation in Function Apps
- Connection pooling for AI enrichment clients
- UUID-based event ID generation (replacing datetime-based)
- Load test baselines directory structure
- DEPRECATED.md for ARM templates migration guide

### Changed
- Standardized dbt metadata columns to `_dbt_run_id`
- Moved SHIR VM auth key to protectedSettings
- Changed OpenLineage auth from API key to OAuth/managed identity
- Changed Cosmos DB disableKeyBasedMetadataWriteAccess default to true
- Parameterized ALZ tags (PrimaryContact, CostCenter)
- Parameterized ALZ storage IP rules
- Improved PII redaction to use service's built-in redacted_text
- Added type hints and docstrings to Python modules

### Security
- Added encryption at host for SHIR VM
- Added CMK parameter pass-through in lake zone storage
- Added outbound NSG deny-all rules with service tag exceptions

---

## Related Documentation

- [README](README.md) — Project overview and quick start
- [Contributing](CONTRIBUTING.md) — Development guidelines and PR process
