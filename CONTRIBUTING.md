# Contributing to CSA-in-a-Box

Thank you for your interest in contributing to Cloud-Scale Analytics in-a-Box.

## Development Setup

### Prerequisites

1. Install required tools:
   - Azure CLI >= 2.50.0
   - Bicep CLI >= 0.22.0
   - PowerShell 7.3+ with Az module
   - Python 3.10+
   - Git 2.40+

2. Clone the repository:
   ```bash
   git clone https://github.com/YOUR-ORG/csa-inabox.git
   cd csa-inabox
   ```

3. Set up Python environment (for scripts/dbt):
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # Linux/Mac
   .venv\Scripts\activate     # Windows
   pip install -r requirements.txt
   ```

## Repository Rules

### Never Commit

- Passwords, API keys, SAS tokens, or connection strings
- `local.settings.json` files
- Python virtual environments (`.venv/`, `venv/`, `dbt-env/`)
- `node_modules/` directories
- Binary artifacts (JARs, compiled binaries)
- IDE-specific secrets or user settings
- Azure subscription IDs in parameter files (use `params.template.json` instead)

### Always Do

- Use `params.template.json` with placeholder values for committed configs
- Run `bicep lint` before submitting Bicep changes
- Add `Try/Catch` error handling in PowerShell scripts
- Parameterize all environment-specific values
- Test deployments with `--what-if` before applying
- Strip notebook outputs before committing (`nbstripout`)

## Code Style

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

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes following the code style guidelines
3. Run linting and validation locally
4. Submit a PR with a clear description of changes
5. Ensure CI checks pass
6. Get at least one approval before merging

## Branch Naming

- `feature/short-description` -- New features
- `fix/short-description` -- Bug fixes
- `infra/short-description` -- Infrastructure changes
- `docs/short-description` -- Documentation updates

## Reporting Issues

Use GitHub Issues with the appropriate template. Include:
- Environment details (subscription type, region)
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs or error messages
