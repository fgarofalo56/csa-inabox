# ADR 0024 — Two-tier test layout: per-package units + central integration

- Status: Accepted
- Date: 2026-05-11
- Deciders: @fgarofalo56
- Related: ADR 0022 (Copilot surfaces); `pyproject.toml` `[tool.pytest.ini_options]`

## Context

The repo had two parallel test directory conventions that grew up
independently:

1. **Central**: `tests/` at repo root, mirroring the package tree
   (e.g. `tests/csa_platform/test_metadata_framework.py`).
2. **Per-package**: `csa_platform/<pkg>/tests/test_*.py` next to the
   code each tests.

Both conventions accumulated tests over time (~1030 in central +
~769 in per-package as of v0.6.6). The pytest config only enumerated
the central path:

```toml
testpaths = ["tests", "portal/shared/portal_tests"]
```

The 22 per-package `tests/` directories were silently never
discovered. `make test` ran 1030 tests; the actual suite was ~1800.
Anyone reading the repo would assume those tests guarded their
packages — they didn't.

Beyond the discovery bug, the layout question itself was never
documented, so contributors didn't know which convention to follow
for new tests.

## Decision

**Keep both conventions, with explicit roles, both discovered.**

### Roles

| Convention | Lives at | What goes here |
|------------|----------|---------------|
| **Per-package units** | `csa_platform/<pkg>/tests/` (and analogous for `apps/copilot/<surface>/tests/`) | Unit tests of a single package's public API; tests that exercise the package in isolation; fast, no Azure dependencies |
| **Central integration** | `tests/`, `portal/shared/portal_tests/` | Cross-package integration; e2e contract tests; tests that need the central `conftest.py` fixtures (script loader, etc.); scripts/ tests; repo-hygiene tests (e.g. `tests/repo/test_feature_status_matrix.py`) |

### Why both

Per-package tests stay close to the code, get reviewed in the same
PR, and don't require contributors to find a parallel directory tree
to add a test. Central integration tests live where they can exercise
multiple packages without a circular dependency on package layout.

Forcing everything into one convention would either (a) drag e2e
contract tests into individual packages (hidden cross-package coupling)
or (b) push unit tests away from the code they test (lower discovery /
review cohesion).

### Pytest configuration

```toml
[tool.pytest.ini_options]
testpaths = ["tests", "portal/shared/portal_tests", "csa_platform"]
pythonpath = ["."]
addopts = "--tb=short -q --strict-markers --import-mode=importlib --ignore=csa_platform/streaming/tests --ignore=csa_platform/multi_synapse/tests"
```

Three non-obvious bits:

- **`--import-mode=importlib`** (rather than the legacy `prepend`) is
  required because both `tests/` and `csa_platform/<pkg>/tests/`
  contain `__init__.py`, and modules with the same basename in
  different `tests` packages (e.g. `tests/contracts/test_*.py` and
  `csa_platform/<pkg>/tests/test_*.py`) would otherwise collide as
  `tests.test_*`. importlib resolves each file by its absolute path.

- **`pythonpath = ["."]`** is required because under `--import-mode=importlib`,
  pytest doesn't prepend the conftest's parent dir to `sys.path` like
  the legacy `prepend` mode does. Without it, `from portal.shared.api...`
  imports in `portal/shared/portal_tests/conftest.py` fail with
  `ModuleNotFoundError: No module named 'portal'`.

- **`portal/shared/portal_tests`** (not `portal/shared/tests`) — same
  collision-avoidance rename done in an earlier session for the
  portal-specific suite.

### Currently ignored

`csa_platform/streaming/tests/` and `csa_platform/multi_synapse/tests/`
import `azure.storage.filedatalake` which isn't pinned on any
project extra. Until the dep is declared on the `streaming` extra,
they're suppressed via the `--ignore` flags above.

## Consequences

- `pytest` and `make test` now collect ~1800 tests, vs. the previous
  silent baseline of ~1030.
- New tests may go in either convention based on the role table above.
- The collision risk we mitigated via `--import-mode=importlib` would
  re-emerge if the project ever rolls back to legacy import mode.
- Two test directories in `csa_platform/` need their dep declared
  before they can be re-enabled (tracked in pytest config comments).

### Discoveries surfaced by enabling per-package collection

Turning on discovery surfaced three real bugs that the silent
discovery had been hiding. Each fixed in the same PR that turned
discovery on:

1. **Missing `pypdf` dep on `dev` extra** — `csa_platform/ai_integration/rag/tests/`
   exercises the pypdf path against committed fixtures. The runtime
   dep was on the `platform` extra (~200MB install); adding it to
   `dev` lets the test suite run without the full platform install.
2. **`great-expectations<1.0.0` pin in validation function's `requirements.txt`** —
   the Test Suite workflow loops over every `requirements.txt` and
   pip-installs each; this pin downgraded GE under the rest of the
   project's `>=1.0.0,<2.0.0` constraint, breaking the GE 1.x demo
   tests with `AttributeError: 'EphemeralDataContext' object has no
   attribute 'data_sources'`. Fixed by removing the dead pin (the
   validation function doesn't actually import GE).
3. **`tutorials` extra not installed in CI** — the GE example tests
   gate on `pytest.importorskip("great_expectations")`, so they were
   silently skipping in CI. Added `tutorials` to the install line in
   `.github/workflows/test.yml` so they actually run.

## Alternatives considered

- **Move per-package tests into `tests/`** mirroring the package
  layout: rejected — increases the per-PR review surface (test edit
  in a different file tree from the code edit) and would require
  moving 46 files.
- **Move all central tests into per-package directories**: rejected —
  e2e/integration tests don't belong inside one package, and the
  scripts/, repo-hygiene, and contract tests aren't tied to a single
  csa_platform sub-package.
- **Pure namespace packages (no `__init__.py`)** to avoid the import-
  mode workaround: rejected — would require auditing every `tests/`
  for `__init__.py` removal and risk hidden import-time side effects.
