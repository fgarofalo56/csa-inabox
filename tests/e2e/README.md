# End-to-End Integration Tests

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** QA Engineers / Developers

This directory contains end-to-end integration tests for the CSA-in-a-Box
platform. The tests validate the full data pipeline from Bronze ingestion
through Gold business tables, data contracts, and the streaming pipeline.

## Quick Start

```bash
# Run all offline tests (DuckDB only, no Azure required)
make test-e2e

# Run all tests including live Azure tests
make test-e2e-live

# Run a specific test file
pytest tests/e2e/test_e2e_platform.py -v
pytest tests/e2e/test_e2e_contracts.py -v
pytest tests/e2e/test_e2e_streaming.py -v
```

## Prerequisites

- Python 3.10+
- Project dev dependencies installed: `pip install -e ".[dev]"`
- DuckDB: `pip install duckdb` (for platform and data quality tests)
- PyYAML (included in `[governance]` extras)

### For live tests only

- Azure CLI installed and authenticated (`az login`)
- Bicep CLI available (`az bicep build`)

## Test Files

### test_e2e_platform.py

10-step end-to-end validation of the full platform:

1. **Bicep params** - All `params*.json` files parse as valid JSON
2. **Bicep build** - `az bicep build` succeeds on DLZ templates (live only)
3. **Bronze ingestion** - Seed CSVs load into DuckDB bronze tables
4. **Silver transforms** - Surrogate keys, lowercased emails, uppercased statuses
5. **Gold transforms** - Dimension and fact tables build correctly
6. **Gold row counts** - Every Gold table has > 0 rows
7. **Data quality** - Uniqueness, no negative amounts, FK integrity
8. **Contract alignment** - Gold columns align with contract definitions
9. **No orphan models** - Every Gold SQL has a schema.yml entry
10. **Domain coverage** - Every domain with data-products has contracts

### test_e2e_contracts.py

Contract validation across all `contract.yaml` files:

- Valid YAML with required fields (apiVersion, kind, metadata, schema)
- Required metadata fields (name, version)
- Columns have name and type
- Version follows semver (e.g., `1.0.0`)
- Column types use supported base types
- Primary keys are non-nullable
- Quality rules reference existing columns
- No orphan contracts (domain directories exist)
- Gold schema.yml PKs have not_null tests

### test_e2e_streaming.py

Streaming pipeline validation:

- Event schema from `produce_events.py` matches ADX RawEvents columns
- Event types are in the known set
- `.asaql` files contain SELECT, FROM, and INTO keywords
- Parentheses are balanced in all queries
- ADX materialized views reference the RawEvents table
- All queries reference `[EventHubInput]` as source
- Streaming ingestion, retention, and ingestion mapping are configured

## Seed Data

Sample data in `seed_data/` is loaded into DuckDB for testing:

| File           | Rows | Description                         |
|----------------|------|-------------------------------------|
| customers.csv  | 10   | Customer records with region/segment|
| orders.csv     | 20   | Orders with product, quantity, price|
| products.csv   | 5    | Product catalog with cost and price |

## Architecture

```text
tests/e2e/
├── __init__.py
├── conftest.py              # DuckDB fixtures, contract loaders
├── test_e2e_platform.py     # 10-step platform integration
├── test_e2e_contracts.py    # Contract YAML validation
├── test_e2e_streaming.py    # Streaming pipeline checks
├── seed_data/
│   ├── customers.csv
│   ├── orders.csv
│   └── products.csv
└── README.md
```

The conftest creates an in-memory DuckDB with the full medallion
architecture (Bronze → Silver → Gold) using simplified SQL that mirrors
the dbt model logic. This allows testing the complete data flow without
Databricks or any external services.

## Markers

- Tests marked `@pytest.mark.live` require Azure CLI / live connection
- Use `make test-e2e` to skip live tests (`-m "not live"`)
- Use `make test-e2e-live` to run everything

---

## Related Documentation

- [Production Checklist](../../docs/PRODUCTION_CHECKLIST.md) - Pre-deployment verification steps
- [Troubleshooting Guide](../../docs/TROUBLESHOOTING.md) - Common issues and solutions
