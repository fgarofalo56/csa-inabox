# Tests

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** All Developers

> [!NOTE]
> **TL;DR:** Centralized test directory covering governance contracts, data quality, platform services, Purview integration, Azure Functions, end-to-end workflows, and load testing.

## 📁 Structure

```text
tests/
├── conftest.py              # Shared pytest fixtures
├── common/                  # Tests for governance/common/
├── contracts/               # Tests for governance/contracts/
├── dataquality/             # Tests for governance/dataquality/
├── e2e/                     # End-to-end integration tests
├── functions/               # Azure Functions unit tests
├── load/                    # Load and performance tests (Locust)
│   └── baselines/           # Performance baselines
├── platform/                # Tests for csa_platform/ services
├── purview/                 # Microsoft Purview integration tests
├── scripts/                 # Test utilities and helpers
└── test_data_quality.py     # Legacy top-level quality test
```

## 🚀 Getting Started

```bash
# Run all unit tests
pytest tests/ -v --ignore=tests/e2e --ignore=tests/load

# Run governance tests only
pytest tests/contracts/ tests/dataquality/ tests/common/ -v

# Run platform tests only
pytest tests/csa_platform/ -v

# Run e2e tests (requires deployed environment)
pytest tests/e2e/ -v

# Run load tests
cd tests/load && locust -f locustfile.py
```

## 📋 Test Mapping

| Test Directory | Tests For | Type |
|---------------|-----------|------|
| `common/` | `governance/common/` | Unit |
| `contracts/` | `governance/contracts/` | Unit |
| `dataquality/` | `governance/dataquality/` | Unit |
| `platform/` | `csa_platform/` services | Unit / Integration |
| `functions/` | Azure Functions | Unit |
| `purview/` | Purview integration | Integration |
| `e2e/` | Cross-component workflows | End-to-end |
| `load/` | API and pipeline performance | Load |

## 🔗 Related Documentation

- [Governance](../governance/README.md) — Governance module under test
- [Platform](../csa_platform/README.md) — Platform services under test
