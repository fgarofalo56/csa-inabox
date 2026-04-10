# Tool Registry

Project-specific tooling, scripts, and automation entry points. Generic Claude
Code skills/commands/agents live under `.claude/skills/`, `.claude/commands/`,
and `.claude/agents/` respectively and are not tracked here.

---

## Make targets (`Makefile`)

| Target | Purpose |
|---|---|
| `setup` / `setup-win` | Create `.venv` and install the project in editable mode with dev extras |
| `lint` / `lint-fix` | Run/fix ruff checks on `domains/`, `scripts/`, `governance/` |
| `lint-bicep` | Build every `.bicep` under `deploy/bicep/` as a lint pass |
| `lint-ps` | Run PSScriptAnalyzer against every `.ps1` |
| `test` | Run pytest against `tests/` |
| `test-dbt` | `dbt compile` + `dbt test` from `domains/shared/dbt` |
| `validate` / `validate-bicep` / `validate-python` / `validate-dbt` | Harness validation gates under `agent-harness/gates/` |
| `deploy-dev` | What-if both DLZ and DMLZ against the dev params files |
| `clean` | Remove caches, `.venv`, and dbt artifacts |

## Agent harness (`agent-harness/`)

- `config.yaml` — Ralph loop configuration (`auto_commit: false` enforced by
  audit finding CI/CD critical #3). Archon project ID is pinned here.
- `gates/validate-*.ps1` — per-language validation gates invoked by the harness
  and surfaced via the `make validate*` targets.

## Governance scripts

- `governance/dataquality/run_quality_checks.py` — data-quality orchestrator
  (dbt test + freshness + volume checks). Great Expectations hook is stubbed
  but not yet wired (Archon task `a211e42f-...`).
- `governance/rbac/apply-rbac.ps1` — applies `rbac-matrix.json` role
  assignments across subscriptions.

## CI/CD workflows (`.github/workflows/`)

| Workflow | Purpose |
|---|---|
| `test.yml` | Python + dbt + Bicep + PowerShell lint + gitleaks on push/PR |
| `bicep-whatif.yml` | PR what-if analysis with matrix over ALZ/DMLZ/DLZ |
| `deploy.yml` | Manual infra deployment with environment approval gates |

## Documentation entry points

- `docs/GETTING_STARTED.md` — 30-minute onboarding walkthrough.
- `docs/TROUBLESHOOTING.md` — common Bicep / dbt / Functions errors.
- `docs/audit/` — 2026-04-10 audit reports and executive summaries.
