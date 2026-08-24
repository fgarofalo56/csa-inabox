# CSA-in-a-Box Dev Loop — Ralph Loop

> **Note (2026-04-18):** This directory was renamed from `agent-harness/` to
> `dev-loop/` to disambiguate from the upcoming CSA Copilot product (which
> will live under `apps/copilot/`). This is a Ralph-loop CI/CD orchestrator
> for project development automation; it contains no LLM/agent runtime.


## Table of Contents

- [Overview](#-overview)
- [How It Works](#-how-it-works)
- [Task Lifecycle](#-task-lifecycle)
- [Validation Gates](#-validation-gates)
- [Integration Points](#-integration-points)
- [Configuration](#-configuration)
- [Archon Project](#-archon-project)
- [Related Documentation](#-related-documentation)

---

## 📋 Overview

The Ralph loop is an autonomous dev loop for iterative implementation, testing, and validation of the CSA-in-a-Box platform. It follows a task-driven development cycle where agents pick up Archon tasks, implement changes, validate them through automated gates, and iterate until validation passes.

---

## 🏗️ How It Works

```mermaid
flowchart TD
    A[Pick Task] --> B[Implement Changes]
    B --> C[Validate Gates]
    C --> D{Pass?}
    D -- No --> E[Fix Issues]
    E --> A
    D -- Yes --> F[Complete Task]
```

---

## 🔄 Task Lifecycle

1. **Pick Task**: Query Archon for next `todo` task in the CSA project
2. **Mark Doing**: Update task status to `doing` in Archon
3. **Implement**: Make code changes following the task description
4. **Validate**: Run validation gates (see below)
5. **Fix/Iterate**: If validation fails, fix issues and re-validate (max 3 iterations)
6. **Complete**: Mark task as `done`, commit changes, pick next task
7. **Escalate**: If max iterations reached, mark for human review

---

## 🧪 Validation Gates

Located in `dev-loop/gates/`:

| Gate | Script | Runs When |
|------|--------|-----------|
| Bicep Lint | `validate-bicep.ps1` | Any `.bicep` file changed |
| Python Lint | `validate-python.ps1` | `.py` under `scripts/`, `domains/`, `tools/`, `csa_platform/`, `dev-loop/`, `governance/` |
| dbt Compile | `validate-dbt.ps1` | Any dbt model changed |
| Deployment | `validate-deployment.ps1` | Infrastructure changes |
| TypeScript | `validate-typescript.ps1` | Console `.ts`/`.tsx` that `tsconfig.build.json` compiles |
| All Gates | `validate-all.ps1` | Always (orchestrator) |
| Self-test | `gate-selftest.ps1` | On demand (`make validate-gates`) |

### What the Python gate does NOT cover

`validate-python.ps1` runs `ruff check` under **pyproject.toml's** rule set over
`scripts/`, `domains/`, `tools/`, `governance/`, `dev-loop/` and `csa_platform/`
— **207 of the repo's 762 tracked `.py` files**. That is the population CI
already enforces (`ruff check domains/ scripts/ csa_platform/ tools/` in
`test.yml` and `validate.yml`) plus `dev-loop` and `governance`, which hold no
tracked `.py` today.

The gate's trigger mirrors that list exactly. It used to be `*.py`, i.e. all 762
— so a change under `portal/`, `tests/`, `apps/`, `azure-functions/`, `cli/`,
`sdk/` or `examples/` selected the gate, the gate linted 207 unrelated files,
and the suite printed `All gates passed!` over a change it had never examined.
`csa_platform/` (170 files, the core platform package) was the sharpest case:
linted by CI on every push and by nothing in `make validate`. Both halves are
now the same list.

The deliberate consequence: **a `.py` change confined to those other trees
selects no gate and `make validate` reports NOT VERIFIED (exit 3)**, not a green
it did not earn. Those trees stay with `test.yml`, `validate.yml` and
`sdk-contract.yml`. Widening this gate to `make lint`'s scope was measured and
deferred: `portal/` + `examples/` carry **758** findings under the pyproject
rules (196 even under the weaker `--select E,F,W --ignore E501` this gate used
to pass on its command line) — debt-paydown work, not this gate's to absorb.

### What the TypeScript gate does NOT cover

`validate-typescript.ps1` is a **typecheck only** (`tsc --noEmit` against
`tsconfig.build.json`). Two gaps, stated rather than implied:

- **Console tests are not covered by `make validate`.** `tsconfig.build.json`
  excludes `**/*.test.ts(x)`, `**/*.spec.ts(x)`, `**/__tests__/**`, `e2e/**`,
  `**/*.uat.ts(x)` and the vitest/playwright configs. Measured: that project
  resolves 4107 files, **zero** of them tests, against 1559 `*.test.ts*` files in
  the tree. The gate's trigger mirrors those excludes, so a test-only change
  selects no gate and `make validate` reports **NOT VERIFIED (exit 3)** rather
  than a green it did not earn. Pointing the gate at `tsconfig.json` was measured
  and deferred: 901 pre-existing type errors, **all 901 in test files**.
- `next build`, eslint and vitest stay with the `fiab-console-ci` workflow, which
  remains the full console gate.

### Required vs optional

`validate-all.ps1` reads the `required:` field each gate already declares in
`config.yaml`. A gate that could not run fails the suite **only if it is
`required: true`** — so a machine without dbt or an Azure session stays green,
while a missing required leg is reported non-zero.

| Gate | `required` |
|------|-----------|
| bicep · python · typescript | `true` |
| dbt · deployment | `false` |

### Exit codes (a contract — callers read it)

| Code | Meaning |
|------|---------|
| 0 | Everything required that was selected got measured; nothing failed |
| 1 | A gate ran and found a problem |
| 2 | `-WhatIf`: nothing invoked, nothing measured |
| 3 | **NOT VERIFIED** — nothing was measured, **or** a `required: true` gate could not run, **or** the registry and the orchestrator disagree. Non-zero on purpose |
| 4 | The orchestrator's own in-process control failed; its answer is meaningless |

Exit 3 exists because `make validate` used to print `All gates passed!` and
return 0 on a change where zero gates ran (#3811). `make validate-gates` runs
the self-test that proves the verdicts still move with their inputs.

---

## 🔌 Integration Points

- **Archon MCP**: Task management, project tracking, document storage
- **GitHub Actions**: CI/CD pipeline execution
- **Azure**: `az deployment what-if` for deployment validation
- **Bicep CLI**: Template compilation and linting
- **ruff**: Python linting
- **dbt**: Data model compilation and testing

---

## ⚙️ Configuration

See `dev-loop/config.yaml` for loop settings:
- Max iterations per task
- Validation gate mappings
- Human review triggers
- Escalation rules

---

## 📋 Archon Project

Project ID: `1bd59749-db0a-4009-82c7-f1a56d24a820`

Query tasks: `find_tasks(filter_by="project", filter_value="1bd59749-db0a-4009-82c7-f1a56d24a820")`

---

## 🔗 Related Documentation

- [Architecture Overview](../docs/ARCHITECTURE.md) — Platform architecture reference
- [Getting Started](../docs/GETTING_STARTED.md) — Platform setup and onboarding
- [Contributing](../CONTRIBUTING.md) — Development guidelines and PR process
