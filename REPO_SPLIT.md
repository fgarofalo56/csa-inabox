# Repository Split Plan

## Current State

This monorepo contains 5 logically independent subsystems that should eventually be separate repositories. Each has distinct ownership, release cadence, and consumers. Splitting will improve CI speed, reduce merge conflicts, and enable independent versioning.

## Proposed Repositories

### 1. `csa-governance` (PyPI package)

**Source:** `governance/`
**Why extract:** Only properly packaged Python module. Zero dependencies on other repo code. Could be `pip install csa-governance`.
**Dependencies:** None (standalone)
**Consumers:** `csa-deploy` (IaC validation), `csa-portal` (quality checks), `csa-platform` (data quality)

**Extraction steps:**

1. Copy `governance/` as repo root
2. Copy relevant sections of `pyproject.toml` (`[project]`, `[tool.setuptools]`, governance deps)
3. Copy `tests/common/`, `tests/contracts/`, `tests/dataquality/`, `tests/e2e/test_e2e_contracts.py`
4. Set up PyPI publishing workflow (`.github/workflows/publish.yml`)
5. In parent repo, replace `governance/` with `pip install csa-governance` dependency

**Boundary validation:** `governance/` imports nothing from `portal/`, `csa_platform/`, `deploy/`, or `examples/`.

### 2. `csa-portal` (Web application)

**Source:** `portal/`, `data/`
**Why extract:** Standalone web app with own frontend, backend, Docker configs, tests. Different release cadence than IaC or governance.
**Dependencies:** None (could optionally depend on `csa-governance` for quality validation)
**Consumers:** End users via browser

**Extraction steps:**

1. Copy `portal/shared/` (backend) and `portal/react-webapp/` (frontend)
2. Copy `portal/kubernetes/` (deployment manifests)
3. Copy `portal/shared/tests/`
4. Standalone `pyproject.toml` with portal deps only
5. Standalone `package.json` workflow for React frontend
6. Copy `data/` for sample/seed datasets

### 3. `csa-deploy` (Infrastructure as Code)

**Source:** `deploy/`, `monitoring/`, `scripts/`, `governance/keyvault/`, `governance/finops/`, `governance/network/`
**Why extract:** IaC has different lifecycle than app code (changes less frequently, different reviewers, different blast radius).
**Dependencies:** None
**Consumers:** Platform engineers deploying Azure infrastructure

**Extraction steps:**

1. Copy `deploy/`, `monitoring/`, `scripts/deploy/`, `scripts/data/`
2. Copy `governance/keyvault/`, `governance/finops/`, `governance/network/` → `governance/` in new repo
3. Copy Bicep-related CI workflows
4. Standalone repo with no Python/Node dependencies (just Azure CLI + Bicep)

### 4. `csa-platform` (Platform services)

**Source:** `csa_platform/`
**Why extract:** Independent microservices, each with own tests and deploy configs. Could further split per service.
**Dependencies:** Optionally `csa-governance` for data quality
**Consumers:** Data engineers, ML engineers

**Extraction steps:**

1. Copy `csa_platform/` as repo root
2. Copy `tests/platform/`, `tests/functions/`, `tests/purview/`
3. Create standalone `pyproject.toml` with platform-specific deps
4. Each sub-component (`data_marketplace/`, `metadata_framework/`, etc.) gets own test and deploy config

**Could further split:** Each platform service could be its own repo, but start with one.

### 5. `csa-examples` (Demo verticals)

**Source:** `examples/`, `domains/`
**Why extract:** Reference implementations that bloat the main repo. Different audience (learners vs. builders).
**Dependencies:** `csa-governance`, `csa-deploy` (for environment setup)
**Consumers:** Government agencies evaluating the platform

**Extraction steps:**

1. Copy `examples/` and `domains/` as repo root
2. Add dependency on `csa-governance` via `pip install`
3. Reference `csa-deploy` templates via git submodule or docs links
4. Minimal CI — just linting and notebook validation

## Migration Order

1. **Extract `csa-governance` first** — cleanest boundary, publishable to PyPI, validates the pattern
2. **Extract `csa-examples` second** — reduces repo size significantly, low risk
3. **Extract `csa-portal` third** — standalone app, clear boundary
4. **Extract `csa-deploy` fourth** — needs careful handling of governance IaC modules
5. **Keep `csa-platform` in main repo or extract last** — most interconnected

## Cross-Repo Dependencies After Split

```
csa-examples  → pip install csa-governance
csa-portal    → pip install csa-governance (optional)
csa-deploy    → standalone (no code deps, copies governance IaC modules)
csa-platform  → pip install csa-governance (optional)
```

No circular dependencies. `csa-governance` is the only shared library.

## Pre-Extraction Checklist

Before extracting any repo:

- [ ] Verify no cross-boundary imports exist (`grep -r "from governance" portal/` etc.)
- [ ] Ensure CI workflows only reference files within the boundary
- [ ] Create `pyproject.toml` / `package.json` scoped to the package
- [ ] Set up independent CI/CD in the new repo
- [ ] Update CODEOWNERS in both old and new repos
- [ ] Add cross-repo dependency (PyPI, git submodule, or docs link)
- [ ] Archive the extracted directory in the monorepo (or delete with redirect README)

## Monorepo Tooling Alternative

If the team prefers keeping a monorepo, consider:

- **Nx** or **Turborepo** for build orchestration
- **Python namespace packages** for shared code
- **GitHub CODEOWNERS** for per-directory review requirements (already in place)
- **Path-filtered CI** via `paths:` in GitHub Actions (partially in place)
- **Pants** or **Bazel** for hermetic builds across Python + TypeScript + Bicep
