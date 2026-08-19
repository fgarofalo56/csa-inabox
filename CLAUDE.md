# CLAUDE.md — CSA-in-a-Box (CSA Loom)

Azure-native reference implementation of Microsoft's "Unify your data platform"
CAF guidance: Fabric-parity capabilities on Azure PaaS, for Government
(pre-Fabric-GA) and regulated Commercial workloads.

The repo is `csa-inabox`; the product it builds is **CSA Loom**. The rules and
docs use the product name — they mean this repo.

This file holds only what you can't infer from the code. The behavioural rules
live in `.claude/rules/` and load automatically — they are not restated here.

---

## The die-hard rules

`.claude/rules/*.md` auto-load. Nine of them are marked **die-hard**: they sit
above convenience and above "it works", and they define what *done* means. Read
the rule itself before arguing with it — each one states its scope and effective
date.

| Rule | In one line |
|---|---|
| `no-vaporware.md` | Nothing ships that only looks implemented. |
| `no-fabric-dependency.md` | No capability may hard-depend on real Microsoft Fabric. |
| `cloud-parity.md` | Same capabilities in Commercial, GCC, GCC-High, IL5, DoD. |
| `auto-bind-by-default.md` | Backing services bind themselves; no user-performed plumbing. |
| `deploy-integrity.md` | Merged is not done. A broken deploy is P0. |
| `ui-parity.md` | Surfaces match Azure & Fabric one-for-one. |
| `ux-baseline.md` | Fabric-grade floor on every front-end surface. |
| `web3-ui.md` | Modern, consistent, picture-perfect UI. |
| `session-end.md` · `task-tracking.md` | Native task list in-session, GitHub Issues across sessions. |

`tool-specifications.md` is path-scoped — it applies under `skills/`,
`commands/`, and `agents/` only.

---

## Gates

```bash
make validate          # ALL gates — this is the bar for "done"
```

`make validate` runs `dev-loop/gates/validate-all.ps1` (PowerShell — `pwsh`, not
Windows PowerShell). Narrower gates when you need a fast loop:

| Command | Scope |
|---|---|
| `make validate-python` · `make validate-bicep` · `make validate-dbt` | One stack |
| `make lint` · `make lint-fix` | ruff |
| `make typecheck` · `make typecheck-platform` | mypy |
| `make lint-bicep` · `make lint-ps` | Bicep / PowerShell |
| `make security` | bandit |
| `make test` · `make test-dbt` · `make console-perf` | pytest / dbt / perf |

A narrow gate passing is not `make validate` passing. Don't report the former as
the latter.

Setup: `make setup` (lean) · `make setup-all` (every extra) · `make setup-win`.
Deploy: `make deploy-dev` · `make deploy-prod`. Run `make help` for the live list —
the Makefile is the source of truth, not this table.

---

## Stack & layout

Python ≥3.10 (invoke as `python`), Bicep for IaC (~350 templates), dbt for
transforms, Next.js for the console.

```
csa-inabox/
├── csa_platform/     # core platform package
├── apps/             # fiab-* apps: console, activator-engine, dbt-runner,
│                     #   direct-lake-shim, copilot, copilot-maf, …
├── portal/           # web portal
├── domains/          # domain packages
├── packages/ sdk/ cli/   # distributables + CLI
├── azure-functions/  # function apps
├── deploy/           # Bicep IaC + deployment
├── dev-loop/gates/   # the validation gates make validate runs
├── PRPs/             # active/ · completed/ · archive/
├── notebooks/ data/ content/ templates/ examples/
├── docs/             # ARCHITECTURE.md, adr/, decisions/, best-practices/, …
├── tests/ tools/ scripts/ monitoring/
└── .claude/          # rules · skills · agents · commands · hooks · workflows
```

---

## Knowledge lookup

| Need | Where |
|---|---|
| Prior session state, decisions, blockers | `.claude/SESSION_KNOWLEDGE.md` |
| What was built and when | `.claude/DEVELOPMENT_LOG.md` |
| What was already tried and failed | `.claude/FAILED_ATTEMPTS.md` |
| Skills/agents/commands inventory | `.claude/TOOL_REGISTRY.md` |
| Architecture, ADRs, decisions | `docs/ARCHITECTURE.md`, `docs/adr/`, `docs/decisions/` |
| Library docs (FastAPI, dbt, React, …) | `project-kb` skill → Context7 MCP |

Check `.claude/FAILED_ATTEMPTS.md` before re-attempting anything that smells
like it's been tried. That file exists because it was.

---

## Tooling provenance

`.claude/skills/`, `.claude/agents/`, and `.claude/commands/` are synced from
`E:\Repos\HouseGarofalo\claude-tools` (the `azure-data-platform` profile in
`scripts/config/skill-tiers.json`). Fixes to a shared skill belong upstream in
claude-tools, then resync — otherwise the next sync overwrites them.

Five skills are deliberately **local-ahead** of canonical and must not be
clobbered by a blind resync: `django-backend`, `mobile-pwa`, `n8n-automation`,
`nestjs-backend`, `excalidraw`.

Skill discovery is exactly one level deep — `.claude/skills/<name>/SKILL.md`.
A skill nested one directory further is silently invisible, with no error.

MCP servers are registered at user scope (`claude mcp add -s user`) and inherited
here; this repo intentionally has no `.mcp.json`.

---

## Conventions

- Line endings: `.gitattributes` pins `eol=lf` for specific paths (`sdk/**`,
  `*.sh`, named scripts) — follow it for anything it covers. It does **not**
  cover `.claude/`, and `.claude/skills/` is untracked entirely, so deployed
  skills carry whatever endings the claude-tools working tree had (currently a
  mix: ~65 LF, ~17 CRLF). That is cosmetic, not a defect — don't "fix" it.
- Temp files go in `./temp/` (gitignored) — never the repo root, never committed.
- Credentials: environment variables and secret stores only. Never in a file,
  a command, or the conversation.

---

## Project Reference

| Key | Value |
|---|---|
| **GitHub** | https://github.com/fgarofalo56/csa-inabox |
| **Path** | `E:\Repos\GitHub\csa-inabox` |
| **Default branch** | `main` |
| **Package** | `csa-inabox` (see `pyproject.toml` for the current version) |

```bash
make validate
gh issue list --state open
gh pr list --state open
```
