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
| Python Lint | `validate-python.ps1` | Any `.py` file changed |
| dbt Compile | `validate-dbt.ps1` | Any dbt model changed |
| Deployment | `validate-deployment.ps1` | Infrastructure changes |
| TypeScript | `validate-typescript.ps1` | Any `apps/fiab-console/**` file changed |
| All Gates | `validate-all.ps1` | Always (orchestrator) |
| Self-test | `gate-selftest.ps1` | On demand (`make validate-gates`) |

`validate-typescript.ps1` is a **typecheck only** (`tsc --noEmit`). `next build`,
eslint and vitest stay with the `fiab-console-ci` workflow, which remains the
full console gate.

`validate-all.ps1` exit codes are a contract:

| Code | Meaning |
|------|---------|
| 0 | At least one gate measured something and nothing failed |
| 1 | A gate ran and found a problem |
| 2 | `-WhatIf`: nothing invoked, nothing measured |
| 3 | **NOT VERIFIED** — nothing was measured (no gate covers this diff, or every selected gate could not run). Non-zero on purpose |
| 4 | The orchestrator's own verdict control failed |

Exit 3 exists because `make validate` used to print `All gates passed!` and
return 0 on a change where zero gates ran (#3811). `make validate-gates` runs
the self-test that proves the verdict still moves with its input.

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
