# Developer Pathways

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** All Developers

This guide maps developer roles to the relevant parts of the codebase. Instead of trying to understand everything at once, focus on the area you'll be working in.

## Quick Start by Role

### Data Engineer
**Focus areas:** `domains/`, `tools/dbt/`, `scripts/seed/`, `scripts/streaming/`
**Technologies needed:** Python, PySpark, dbt (SQL + Jinja), Delta Lake
**Getting started:**
1. Run `make setup` (or `make setup-win` on Windows)
2. Explore `domains/shared/dbt/` for the core data models
3. Run `make test-dbt` to verify dbt compilation
4. Review `domains/finance/`, `domains/sales/`, `domains/inventory/` for domain examples

### Governance Developer
**Focus areas:** `governance/`, `tests/`
**Technologies needed:** Python, structlog, pytest
**Getting started:**
1. Run `make setup`
2. Run `make test` — this validates governance code with 80% coverage gate
3. Key modules: `governance/contracts/` (data contracts), `governance/dataquality/` (quality rules)
4. Run `make typecheck` for strict mypy validation

### Platform / AI Engineer
**Focus areas:** `platform/ai_integration/`, `platform/metadata-framework/`, `platform/data_marketplace/`
**Technologies needed:** Python, Azure OpenAI, Azure AI Search, FastAPI
**Getting started:**
1. Run `pip install -e ".[platform]"` for platform dependencies
2. Explore `platform/ai_integration/rag/` for the RAG pipeline
3. See `platform/metadata-framework/generator/` for pipeline auto-generation
4. Run `make typecheck-platform` for type checking

### Infrastructure / DevOps Engineer
**Focus areas:** `deploy/bicep/`, `monitoring/`, `.github/workflows/`, `portal/kubernetes/`
**Technologies needed:** Bicep, Azure CLI, GitHub Actions, Helm
**Getting started:**
1. Run `make lint-bicep` to validate Bicep templates
2. Review `deploy/bicep/DLZ/` (Data Landing Zone) and `deploy/bicep/DMLZ/` (Data Management Landing Zone)
3. Check `monitoring/alerts/` for operational alerting
4. See `.github/workflows/deploy.yml` for CI/CD pipeline

### Frontend Developer
**Focus areas:** `portal/react-webapp/`, `portal/static-webapp/`, `portal/shared/`
**Technologies needed:** TypeScript, React/Next.js or Svelte/SvelteKit, Tailwind CSS
**Getting started:**
1. `cd portal/react-webapp && npm install && npm run dev`
2. Shared type definitions: `portal/shared/contracts/types.ts`
3. Component library: `portal/react-webapp/src/components/`
4. Auth config: `portal/react-webapp/src/services/authConfig.ts`

### Azure Functions Developer
**Focus areas:** `domains/sharedServices/*/functions/`
**Technologies needed:** Python, Azure Functions SDK, Azure SDKs
**Getting started:**
1. Run `pip install -e ".[functions]"`
2. Three function apps: `aiEnrichment/`, `eventProcessing/`, `secretRotation/`
3. Each has a `function_app.py` entry point
4. Tests: `tests/functions/`

## Directory Map

| Directory | Purpose | Owner Role |
|-----------|---------|------------|
| `deploy/bicep/` | Infrastructure as Code (Bicep) | DevOps |
| `domains/` | Data domain models (finance, sales, inventory) | Data Engineer |
| `examples/` | Reference implementations for gov agencies | Data Engineer |
| `governance/` | Data governance framework (contracts, quality, RBAC) | Governance Dev |
| `monitoring/` | Alerting and dashboards (Bicep + Grafana) | DevOps |
| `platform/` | Platform services (AI, metadata, marketplace) | Platform Engineer |
| `portal/` | Web portal (React, Svelte, K8s deployment) | Frontend Dev |
| `scripts/` | Operational scripts (deploy, seed, monitor) | DevOps |
| `templates/` | Data product templates | Data Engineer |
| `tests/` | Test suite (unit, e2e, contracts, load) | All |
| `tools/` | Development tools (dbt) | Data Engineer |

## Common Tasks

| Task | Command |
|------|---------|
| Set up dev environment | `make setup` / `make setup-win` |
| Run all tests | `make test` |
| Run linter | `make lint` |
| Auto-fix lint issues | `make lint-fix` |
| Type check governance | `make typecheck` |
| Type check platform | `make typecheck-platform` |
| Validate Bicep | `make lint-bicep` |
| Run dbt tests | `make test-dbt` |
| Deploy to dev (dry run) | `make deploy-dev` |
| Load sample data | `make seed` |
| Run security scan | `make security` |

## Architecture Overview

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system architecture.

**High-level structure:**
- **Data Mesh pattern**: Each domain (finance, sales, inventory) owns its data models
- **Medallion architecture**: Bronze (raw) → Silver (cleaned) → Gold (business-ready)
- **Governance as code**: Data contracts, quality rules, and RBAC policies defined in YAML/JSON
- **Platform services**: AI enrichment, metadata framework, and data marketplace as shared services
