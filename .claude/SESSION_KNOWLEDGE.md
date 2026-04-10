# Session Knowledge

Live state for the current working session. Updated as work progresses.
The end-of-session protocol (`.claude/rules/session-end.md`) rewrites this at
the close of each session.

---

## Current Session — 2026-04-10

**Focus:** Triage in-progress audit remediation work, commit it, then execute
the visible Archon todo backlog from the 2026-04-10 audit sweep.

**Archon project:** `1bd59749-db0a-4009-82c7-f1a56d24a820` — CSA-in-a-Box: Cloud-Scale Analytics Platform

### Outcome

**15 commits landed on `main`, working tree clean.**

#### Phase A — Triage + hygiene (5 commits)

1. `84aa05b` chore: repo hygiene — archive audit reports, bootstrap .claude tracking
2. `d998c6e` ci: harden CI/CD safety gates per 2026-04-10 audit findings
3. `e75d85e` docs: add GETTING_STARTED + TROUBLESHOOTING guides and tests scaffold
4. `6a8bff5` security: lock down infra + data-plane per Bicep and code-quality audits
5. `243d8a4` chore(claude): commit project rules + hooks, ignore global-synced dirs

#### Phase B — Archon todo execution (10 commits, 10 tasks)

1. `d0cb142` refactor(validation): consolidate three email regexes into one source — closes `b9b4f126`
2. `e0fcb4a` infra(bicep): bump Synapse, Key Vault, ACR API versions to current GA — closes `57ed2e42`
3. `7e8174a` ci(coverage): enforce 80% test coverage threshold and publish reports — closes `8b735520`
4. `c6e2d8f` ops: add deployment rollback workflow, PITR configs, and runbook — closes `74b1d983`
5. `5487848` feat(logging): structured JSON logging with trace IDs across services — closes `7c36dbc6`
6. `7494e38` chore(types): add type hints and enable strict mypy across Python code — closes `43511368`
7. `a40dbb1` perf(functions): convert Azure Functions to async for concurrent throughput — closes `02179890`
8. `e0c1da9` feat(data-quality): wire up Great Expectations checkpoint runner — closes `a211e42f`
9. `3ed82e4` test(load): add Locust / k6 / dbt-bench harness and on-demand workflow — closes `a7a82cb2`
10. `ac00139` ops(dr): multi-region DR strategy — Bicep toggles, runbook, tier matrix — closes `3c27e17d`

### What is now in the repo that wasn't before

**New modules**
- `governance/common/validation.py` — canonical email regex + placeholder expansion for YAML rule files.
- `governance/common/logging.py` — structlog-backed JSON logging with trace/correlation context.
- `governance/dataquality/ge_runner.py` — Great Expectations checkpoint runner with an in-memory fallback evaluator.
- `tests/load/` — Locust + k6 + dbt-benchmark harness, all gated behind the on-demand `.github/workflows/load-tests.yml` workflow.

**New workflows**
- `.github/workflows/rollback.yml` — Bicep redeploy at an arbitrary git tag with `ROLLBACK` confirmation gate.
- `.github/workflows/load-tests.yml` — `workflow_dispatch` only, four load-test targets.

**New docs**
- `docs/GETTING_STARTED.md` / `docs/TROUBLESHOOTING.md` — closes the F-grade onboarding gap.
- `docs/audit/` — six audit reports moved out of the repo root.
- `docs/ROLLBACK.md` — deploy-failure runbook.
- `docs/DR.md` — regional-outage runbook with RPO/RTO tier matrix.
- `docs/LOG_SCHEMA.md` — JSON log schema + KQL queries for Log Analytics.

**Test suite**
- 61 tests passing, 93.10% coverage on the measured packages (`governance/common/`, `governance/dataquality/ge_runner.py`).
- Strict mypy passes on 16 source files in the default target plus both Function apps checked separately.
- Coverage gate at 80% enforced in CI via `.github/workflows/test.yml`.

**CI/CD safety**
- Every workflow has `timeout-minutes`.
- `deploy.yml` uses GitHub environment approval gates and emits `deploy/<env>-<sha>-<run>` tags on success.
- `agent-harness/config.yaml` has `auto_commit: false`.
- `.pre-commit-config.yaml` + `deploy/bicep/bicepconfig.json` wire gitleaks / ruff / bicep-build / linter rules.

### Important follow-ups discovered mid-session

**There are 10 more Archon todos I did not work on.** Default `find_tasks`
pagination returns 10 items, so the "10 todo" I reported at session start
was actually just the first page. A second page exists with task_order
83–107, and the user has not yet seen them:

- `d55952f9` Uncomment and implement Unity Catalog RBAC permissions
- `b210c0cf` Add ML model approval gate and remove synthetic data fallback
- `ec22583d` Enforce data contracts programmatically
- `592588c2` Add GitHub Environment protection rules for production deployments
- `310b5446` Move surrogate key generation from Bronze to Silver layer
- `0ac384b5` Change Silver layer to flag (not filter) bad records
- `e019c879` Implement Customer-Managed Key (CMK) encryption for compliance
- `2bce6682` Build secret rotation automation (Azure Function App)
- `ab7085b0` Extend audit log retention beyond 90 days
- `be5429f6` Build VNet/subnet/NSG/private DNS Bicep modules (biggest — flagged as "most critical infrastructure gap")

These are on the user's plate to decide whether to run another pass.

### Decisions & discoveries

- **Coverage scope**: the gate measures `governance/common/` and
  `governance/dataquality/` (minus the integration-tested runner CLI).
  New Python modules need to be added here as they grow tests.
- **Mypy strict + two Function apps**: both `function_app.py` files
  collide on module resolution, so mypy is invoked three times
  (default target + one per Function app) from both the Makefile
  (`make typecheck`) and the `test.yml` workflow.
- **GE fallback evaluator**: `great_expectations` is a 200MB dep; the
  in-memory evaluator covers every expectation type currently in
  `quality-rules.yaml` so unit tests stay fast.
- **Load tests gated behind workflow_dispatch**: they hit live
  environments and incur cost — intentionally not on PR/push.
- **Bicep DR toggles are opt-in**: `storageSku` defaults to the
  existing ZRS/LRS logic; `secondaryLocation` defaults to empty.
  Callers have to explicitly request geo-redundancy on critical
  workloads — see `docs/DR.md` §1 for the tier matrix.

### Blockers / open questions

- Does the user want me to continue with the 10-task second page?
  (Session ended at a natural boundary — working tree clean, all 10
  visible todos closed, tests/mypy green.)
