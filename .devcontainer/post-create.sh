#!/usr/bin/env bash
# Devcontainer post-create bootstrap.
# Runs ONCE when the container is first created (not on subsequent starts).
# Idempotent: safe to re-run.

set -euo pipefail

echo ""
echo "============================================================"
echo "  csa-inabox devcontainer post-create"
echo "============================================================"
echo ""

# ---------- 1. Python environment ----------
echo "→ Upgrading pip / wheel"
python -m pip install --quiet --upgrade pip wheel setuptools

echo "→ Installing csa-inabox in editable mode with dev + governance extras"
# Minimum set for first-day productivity. Heavier extras (platform, portal,
# functions, postgres) can be added by the contributor as needed:
#   pip install -e ".[platform,portal,postgres]"
pip install --quiet -e ".[dev,governance,tutorials]"

# ---------- 2. Pre-commit hooks ----------
echo "→ Installing pre-commit hooks (gitleaks, ruff, mypy, mkdocs-strict, bicep-lint, ...)"
pre-commit install --install-hooks

# ---------- 3. Bicep CLI (already provided by the azure-cli feature; verify) ----------
if command -v az >/dev/null 2>&1; then
    echo "→ Azure CLI: $(az version --query '"azure-cli"' -o tsv 2>/dev/null || echo 'installed')"
    az bicep install >/dev/null 2>&1 || true
    if az bicep version >/dev/null 2>&1; then
        echo "→ Bicep CLI: $(az bicep version 2>&1 | head -1)"
    fi
fi

# ---------- 4. MkDocs (so `mkdocs serve` works for docs preview) ----------
echo "→ Installing MkDocs Material + plugins for local docs preview"
pip install --quiet \
    mkdocs-material \
    mkdocs-minify-plugin \
    mkdocs-include-markdown-plugin \
    mkdocs-glightbox \
    pymdown-extensions

# ---------- 5. Node deps for the portal frontend (if package.json exists) ----------
if [ -f portal/react-webapp/package.json ]; then
    echo "→ Installing portal/react-webapp Node dependencies"
    (cd portal/react-webapp && npm ci --no-audit --no-fund) || \
        echo "  (skip — run 'cd portal/react-webapp && npm ci' if you need the portal)"
fi

# ---------- 6. Playwright browsers (frontend E2E) ----------
# Lazy — only install if the project actually uses Playwright. Cheap if
# unused, expensive (~400MB) if installed; gate on a marker file.
if [ -f portal/react-webapp/playwright.config.ts ] || grep -rq "from playwright" tests/ 2>/dev/null; then
    echo "→ Installing Playwright browsers (chromium only — fastest path)"
    pip install --quiet playwright || true
    python -m playwright install --with-deps chromium || \
        echo "  (Playwright install failed — run 'python -m playwright install chromium' manually if you need E2E)"
fi

# ---------- 7. Git safety + correctness ----------
git config --global --add safe.directory /workspaces/csa-inabox
git config --global pull.rebase false
git config --global push.autoSetupRemote true

# ---------- Done ----------
echo ""
echo "============================================================"
echo "  Setup complete. Quick start:"
echo ""
echo "    make help               # see all available targets"
echo "    make test               # run the Python test suite"
echo "    make lint               # run ruff + mypy"
echo "    make validate-bicep     # lint Bicep templates"
echo "    mkdocs serve            # preview the docs site (port 8000)"
echo ""
echo "  Read CONTRIBUTING.md and docs/GETTING_STARTED.md for the"
echo "  30-minute tour."
echo "============================================================"
echo ""
