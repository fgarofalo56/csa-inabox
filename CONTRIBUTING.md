# Contributing to CSA-in-a-Box

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Contributors

> [!NOTE]
> **Quick Summary**: This guide covers development setup, repository rules, code style conventions (Bicep, PowerShell, Python), the PR process, branch naming, and how to report issues. Follow the checklist below for a smooth contribution experience.

Thank you for your interest in contributing to Cloud-Scale Analytics in-a-Box.

---

## 📑 Table of Contents

- [🚀 Development Setup](#-development-setup)
- [⚠️ Repository Rules](#️-repository-rules)
- [💡 Code Style](#-code-style)
- [🤝 Pull Request Process](#-pull-request-process)
- [🏷️ Branch Naming](#️-branch-naming)
- [🔧 Reporting Issues](#-reporting-issues)
- [🔗 Related Documentation](#-related-documentation)

---

## 🚀 Development Setup

### 📎 Prerequisites

- [ ] Azure CLI >= 2.50.0
- [ ] Bicep CLI >= 0.25
- [ ] PowerShell 7.3+ with Az module
- [ ] Python 3.10+
- [ ] Git 2.40+

### 📦 Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/fgarofalo56/csa-inabox.git
   cd csa-inabox
   ```

2. Set up Python environment (for scripts/dbt):
   ```bash
   make setup            # Linux/Mac
   make setup-win        # Windows
   ```
   This creates a `.venv`, activates it, and installs all dev dependencies
   from `pyproject.toml`. To activate the venv manually afterwards:
   ```bash
   source .venv/bin/activate  # Linux/Mac
   .venv\Scripts\activate     # Windows
   ```

3. Install pre-commit hooks:
   ```bash
   pre-commit install
   ```
   This enables automatic linting, formatting, and secret detection on every commit.

---

## ⚠️ Repository Rules

### Never Commit

> [!CAUTION]
> The following must **never** be committed to the repository:

- Passwords, API keys, SAS tokens, or connection strings
- `local.settings.json` files
- Python virtual environments (`.venv/`, `venv/`, `dbt-env/`)
- `node_modules/` directories
- Binary artifacts (JARs, compiled binaries)
- IDE-specific secrets or user settings
- Azure subscription IDs in parameter files (use `params.template.json` instead)

### Always Do

> [!TIP]
> Follow these practices for every contribution:

- Use `params.template.json` with placeholder values for committed configs
- Run `bicep lint` before submitting Bicep changes
- Add `Try/Catch` error handling in PowerShell scripts
- Parameterize all environment-specific values
- Test deployments with `--what-if` before applying
- Strip notebook outputs before committing (`nbstripout`)

---

## 💡 Code Style

### Bicep
- Use camelCase for parameters and variables
- Use PascalCase for resource symbolic names
- Add `@description()` decorators to all parameters
- Add `@minLength()` / `@maxLength()` / `@allowed()` constraints where applicable
- Use modules for reusable components

### PowerShell
- Use `Set-StrictMode -Version Latest` at the top
- Use `$ErrorActionPreference = 'Stop'`
- Wrap operations in `Try/Catch` blocks
- Use `-WhatIf` support for destructive operations
- Use approved verbs (Get-, Set-, New-, Remove-)

### Python
- Follow PEP 8
- Use type hints
- Use `pathlib.Path` for file operations
- Add docstrings to all public functions

---

## 🤝 Pull Request Process

```mermaid
graph LR
    A["Create Branch"] --> B["Make Changes"]
    B --> C["Run Lint & Validation"]
    C --> D["Submit PR"]
    D --> E["CI Checks Pass?"]
    E -- Yes --> F["Code Review"]
    E -- No --> C
    F --> G["Approved?"]
    G -- Yes --> H["Merge to main"]
    G -- No --> B
```

### Contribution Checklist

- [ ] Create a feature branch from `main`
- [ ] Make your changes following the code style guidelines
- [ ] Run linting and validation locally
- [ ] Submit a PR with a clear description of changes
- [ ] Ensure CI checks pass
- [ ] Get at least one approval before merging

---

## 🏷️ Branch Naming

| Prefix | Purpose | Example |
|---|---|---|
| `feature/` | New features | `feature/add-streaming-domain` |
| `fix/` | Bug fixes | `fix/inventory-turnover-sql` |
| `infra/` | Infrastructure changes | `infra/nsg-outbound-rules` |
| `docs/` | Documentation updates | `docs/update-quickstart` |

---

## 🔧 Reporting Issues

Use GitHub Issues with the appropriate template. Include:

- [ ] Environment details (subscription type, region)
- [ ] Steps to reproduce
- [ ] Expected vs actual behavior
- [ ] Relevant logs or error messages

---

## 🔗 Related Documentation

| Document | Description |
|---|---|
| [README](README.md) | Project overview and quick start |
| [Changelog](CHANGELOG.md) | All notable changes to the project |
