# Session Knowledge

Live state for the current working session. Updated as work progresses.
The end-of-session protocol (`.claude/rules/session-end.md`) rewrites this at
the close of each session.

---

## Current Session — 2026-04-10

**Focus:** Triage in-progress audit remediation work, commit it, then execute
the 10 Archon todo tasks opened by the 2026-04-10 audit sweep.

**Archon project:** `1bd59749-db0a-4009-82c7-f1a56d24a820` — CSA-in-a-Box: Cloud-Scale Analytics Platform

### Starting state (captured at session start)

- **Git:** `main`, 26 modified files + many untracked (audit reports, new docs,
  `tests/`, `.pre-commit-config.yaml`, `bicepconfig.json`, `.github/copilot-instructions.md`,
  a stray `lasaalzdevmnkirlpeaqrwm.bicep` portal export at the repo root, two
  Azure built-in policy CSV reference dumps).
- **Archon tasks:** 0 doing, 0 review, 10 todo, all medium priority.
- **Audit findings:** 41 CI/CD issues (11 critical, 10 high), plus 20 Bicep
  findings, plus documentation/DX gaps (overall grade C+).

### In-progress audit fixes already in the working tree

Most critical audit issues are already partially addressed in uncommitted edits:

- `agent-harness/config.yaml` — `auto_commit: false` (fixes CI/CD critical #3).
- `.pre-commit-config.yaml` — new, wires gitleaks + ruff + bicep-build hooks.
- `deploy/bicep/bicepconfig.json` — new, enables core Bicep linter rules.
- `docs/GETTING_STARTED.md`, `docs/TROUBLESHOOTING.md` — new onboarding guides.
- `.github/workflows/*.yml` — `timeout-minutes` added to every job; `deploy.yml`
  uses `environment:` for GitHub approval gates (critical #5).
- `Makefile` — `setup`/`setup-win` chained with `&&` (critical #11); `clean`
  targets now use `-` prefix instead of `|| true` (critical #10).
- `tests/` — scaffold with `test_data_quality.py`.
- `pyproject.toml` — richer ruff rules, mypy config, dev dependencies.

### Plan for this session

1. Bootstrap `.claude/` tracking files (this file, `DEVELOPMENT_LOG.md`,
   `FAILED_ATTEMPTS.md`, `TOOL_REGISTRY.md`).
2. Declutter repo root: move audit artifacts under `docs/audit/`, drop the
   stray portal export, relocate Azure policy CSVs to `governance/policies/reference/`.
3. Commit the 26 in-progress audit fixes in three logical chunks
   (CI/CD safety · tooling & docs · code quality).
4. Execute the 10 Archon todos in size order (smallest first):
   - Email regex consolidation
   - Bicep API version refresh (Synapse, Key Vault, ACR)
   - Coverage threshold in CI
   - Deployment rollback workflow
   - Structured JSON logging with trace IDs
   - Type hints + mypy strict
   - Async Functions conversion
   - Great Expectations wiring
   - Load/performance tests (scaffold)
   - Multi-region DR strategy (doc-first)

### Decisions & discoveries

*(updated as work happens)*

### Blockers / open questions

*(none yet)*
