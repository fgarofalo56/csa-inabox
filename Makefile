.PHONY: help setup lint test validate deploy-dev deploy-prod deploy-adf prerequisites seed seed-azure clean security typecheck-platform portal-dev portal-dev-stop portal-test portal-lint portal-docker teardown-dev teardown-staging teardown-prod teardown-example sample-up sample-down helm-lint

# Default target
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Setup ---

# CSA-0062: EXTRAS variable drives which pyproject.toml extras are installed.
# Default is "dev,governance,functions" for backward compatibility. Override
# to include portal/copilot/platform when you need them:
#     make setup EXTRAS=dev,portal,copilot
# Common recipes:
#     make setup                                 # backend-only dev
#     make setup EXTRAS=dev,portal               # portal work
#     make setup EXTRAS=dev,portal,copilot       # portal + copilot
#     make setup EXTRAS=dev,governance,functions,portal,copilot,platform   # everything
EXTRAS ?= dev,governance,functions

setup: ## Set up development environment (override with EXTRAS=dev,portal,copilot)
	python -m venv .venv && \
	. .venv/bin/activate && \
	pip install --upgrade pip && \
	pip install -e ".[$(EXTRAS)]"
	@echo ""
	@echo "Installed with extras: [$(EXTRAS)]"
	@echo "Activate with: source .venv/bin/activate"

setup-win: ## Set up development environment (Windows; honors EXTRAS)
	python -m venv .venv
	.venv\Scripts\pip install --upgrade pip
	.venv\Scripts\pip install -e ".[$(EXTRAS)]"
	@echo ""
	@echo "Installed with extras: [$(EXTRAS)]"
	@echo "Activate with: .venv\Scripts\activate"

# --- Linting ---

lint: ## Run all linters (uses pyproject.toml rule config)
	ruff check domains/ scripts/ tools/ csa_platform/ portal/ examples/
	@echo "Python lint passed"

lint-fix: ## Auto-fix lint issues
	ruff check domains/ scripts/ tools/ csa_platform/ portal/ examples/ --fix
	ruff format domains/ scripts/ tools/ csa_platform/ portal/ examples/

typecheck: ## Run strict mypy on governance, tests, and all three Function apps
	mypy
	mypy csa_platform/functions/aiEnrichment/functions/function_app.py
	mypy csa_platform/functions/eventProcessing/functions/function_app.py
	mypy csa_platform/functions/secretRotation/functions/function_app.py
	@echo "mypy strict passed"

typecheck-platform: ## Run mypy on platform modules (progressive strictness)
	# Use -p (package mode) instead of a directory path so mypy resolves
	# each module through the csa_platform package root and does not see
	# the same file under two module names ("ai_integration.*" AND
	# "csa_platform.ai_integration.*").  Requires csa_platform/__init__.py.
	mypy -p csa_platform.ai_integration --ignore-missing-imports
	mypy -p csa_platform.data_marketplace --ignore-missing-imports
	mypy -p csa_platform.metadata_framework --ignore-missing-imports
	mypy -p csa_platform.governance --ignore-missing-imports
	@echo "mypy platform passed"

lint-bicep: ## Lint all Bicep files
	@find deploy/bicep -name "*.bicep" -not -path "*/node_modules/*" -exec sh -c 'echo "Building: {}"; bicep build {} && rm -f "$${1%.bicep}.json"' _ {} \;

lint-ps: ## Lint PowerShell scripts
	pwsh -Command "Get-ChildItem -Recurse -Filter *.ps1 | ForEach-Object { Invoke-ScriptAnalyzer -Path $$_.FullName -Severity Warning }"

security: ## Run Bandit security linter
	bandit -r csa_platform/ domains/ scripts/ -c pyproject.toml

# --- Testing ---

test: ## Run all tests
	pytest tests/ --tb=short -q

test-e2e: ## Run integration tests (offline, DuckDB only)
	pytest tests/integration/ -v --tb=short -m "not live"

test-e2e-live: ## Run all integration tests (requires Azure connection)
	pytest tests/integration/ -v --tb=short

test-dbt: ## Compile and test dbt models
	cd domains/shared/dbt && dbt compile --profiles-dir .
	cd domains/shared/dbt && dbt test --profiles-dir .

# --- Validation ---

validate: ## Run all validation gates
	pwsh -File dev-loop/gates/validate-all.ps1

validate-bicep: ## Validate Bicep templates only
	pwsh -File dev-loop/gates/validate-bicep.ps1

validate-python: ## Validate Python code only
	pwsh -File dev-loop/gates/validate-python.ps1

validate-dbt: ## Validate dbt models only
	pwsh -File dev-loop/gates/validate-dbt.ps1
# --- Deployment ---

deploy-dev: ## Deploy to dev environment (what-if)
	@echo "Running what-if for all landing zones..."
	bash scripts/deploy/deploy-platform.sh --environment dev --dry-run

deploy-prod: ## Deploy to production (requires confirmation)
	@echo "⚠️  WARNING: You are about to deploy to PRODUCTION"
	@read -p "Type 'DEPLOY' to confirm: " confirm && [ "$$confirm" = "DEPLOY" ] || (echo "Aborted." && exit 1)
	bash scripts/deploy/deploy-platform.sh --environment prod

deploy-adf: ## Deploy ADF pipelines to a Data Factory instance
	bash scripts/deploy/deploy-adf.sh --factory-name $(FACTORY_NAME) --resource-group $(RESOURCE_GROUP) $(if $(DRY_RUN),--dry-run)

prerequisites: ## Validate deployment prerequisites
	bash scripts/deploy/validate-prerequisites.sh

# --- Teardown (FinOps safety) ---

teardown-dev: ## Tear down dev platform resources (CI automation, skips confirmation)
	bash scripts/deploy/teardown-platform.sh --env dev --yes

teardown-staging: ## Tear down staging platform resources (interactive confirmation)
	bash scripts/deploy/teardown-platform.sh --env staging

teardown-prod: ## Tear down production platform resources (interactive confirmation, NEVER --yes)
	@echo "Refusing to use --yes against prod; you will be prompted to type DESTROY-prod."
	bash scripts/deploy/teardown-platform.sh --env prod

teardown-example: ## Tear down a single vertical example: make teardown-example VERTICAL=usda
	@if [ -z "$(VERTICAL)" ]; then echo "Usage: make teardown-example VERTICAL=<name>"; exit 1; fi
	@if [ ! -f "examples/$(VERTICAL)/deploy/teardown.sh" ]; then \
		echo "No teardown.sh for '$(VERTICAL)'. Expected examples/$(VERTICAL)/deploy/teardown.sh"; exit 1; \
	fi
	bash examples/$(VERTICAL)/deploy/teardown.sh $(if $(DRYRUN),--dry-run) $(if $(YES),--yes)

seed: ## Load sample data via dbt seed
	cd domains/shared/dbt && dbt seed --profiles-dir .

seed-azure: ## Upload sample data to ADLS (requires --storage-account)
	python scripts/seed/load_sample_data.py --mode adls --storage-account $(STORAGE_ACCOUNT)

# --- Portal ---

# CSA-0051: portal-dev supervises FastAPI + Next.js + the dbt-ci stub in
# parallel and traps SIGINT / SIGTERM so Ctrl-C kills the whole process
# tree (previously the uvicorn child was orphaned). Plain bash supervisor
# — no honcho/overmind dependency required. POSIX-bash compatible.
#
# Log files land in ./logs/portal-dev/<component>.log so components are
# separable. `make portal-dev-stop` kills any lingering pids.
#
# Prerequisites:
#   - Python deps:  make setup EXTRAS=dev,portal
#   - Node deps:    cd portal/react-webapp && npm install
#   - dbt deps:     pip install "dbt-core>=1.7,<2.0" "dbt-duckdb>=1.7,<2.0"
portal-dev:  ## Start portal backend + frontend + dbt-ci stub under one supervisor
	@mkdir -p logs/portal-dev
	@rm -f logs/portal-dev/.pids
	@echo "Starting portal-dev supervisor (logs in logs/portal-dev/)"
	@bash -c ' \
		set -m; \
		trap "echo Stopping...; kill 0 2>/dev/null; wait" INT TERM; \
		( ENVIRONMENT=local DEMO_MODE=true \
		  uvicorn portal.shared.api.main:app --reload --port 8000 \
		  2>&1 | tee logs/portal-dev/backend.log ) & \
		echo $$! >> logs/portal-dev/.pids; \
		( cd portal/react-webapp && npm run dev \
		  2>&1 | tee ../../logs/portal-dev/frontend.log ) & \
		echo $$! >> logs/portal-dev/.pids; \
		( bash .github/workflows/dbt-ci-smoke.sh \
		  2>&1 | tee logs/portal-dev/dbt-ci.log ) & \
		echo $$! >> logs/portal-dev/.pids; \
		wait \
	'

portal-dev-stop:  ## Stop any pids left behind by portal-dev
	@if [ -f logs/portal-dev/.pids ]; then \
		while read pid; do \
			[ -n "$$pid" ] && kill "$$pid" 2>/dev/null || true; \
		done < logs/portal-dev/.pids; \
		rm -f logs/portal-dev/.pids; \
		echo "portal-dev stopped"; \
	else \
		echo "no portal-dev pids to stop"; \
	fi

portal-test:  ## Run all portal tests (backend + frontend)
	ENVIRONMENT=local python -m pytest portal/shared/tests/ --tb=short -q
	cd portal/react-webapp && npx jest --no-cache

portal-lint:  ## Lint portal code (Python + TypeScript)
	python -m ruff check portal/shared/api/
	cd portal/react-webapp && npx eslint src/

portal-docker:  ## Start portal via Docker Compose
	docker compose -f portal/kubernetes/docker/docker-compose.yml up --build

# --- Sample vertical bring-up (CSA-0052) ---

# `make sample-up NAME=<vertical>` runs the full chain for a single
# vertical example: validate → deploy (dry-run) → seed → dbt → verify.
# Stage scripts live in scripts/sample-up/; each is POSIX-bash and safe
# to run individually. Pass FULL_DEPLOY=1 to run a real deploy instead
# of --dry-run.
#
# Usage:
#   make sample-up NAME=usda
#   make sample-up NAME=noaa FULL_DEPLOY=1
#   make sample-down NAME=usda
sample-up:  ## Validate → deploy → seed → dbt → verify a vertical example
	@if [ -z "$(NAME)" ]; then echo "Usage: make sample-up NAME=<vertical>"; exit 1; fi
	bash scripts/sample-up/01-validate.sh "$(NAME)"
	bash scripts/sample-up/02-deploy.sh "$(NAME)"
	bash scripts/sample-up/03-seed.sh "$(NAME)"
	bash scripts/sample-up/04-dbt.sh "$(NAME)"
	bash scripts/sample-up/05-verify.sh "$(NAME)"

sample-down:  ## Tear down the vertical brought up by sample-up (alias for teardown-example)
	@if [ -z "$(NAME)" ]; then echo "Usage: make sample-down NAME=<vertical>"; exit 1; fi
	$(MAKE) teardown-example VERTICAL="$(NAME)" $(if $(DRYRUN),DRYRUN=1) $(if $(YES),YES=1)

# --- Helm (CSA-0055) ---

# helm-lint mirrors the .github/workflows/helm-lint.yml CI job so PR
# failures reproduce locally. Uses --strict so values.schema.json
# (CSA-0053) is enforced.
HELM_CHART_DIR ?= portal/kubernetes/helm/csa-portal

helm-lint:  ## Run helm lint --strict + template render on the portal chart
	@command -v helm >/dev/null 2>&1 || { echo "helm not installed — see https://helm.sh/docs/intro/install/"; exit 1; }
	helm lint --strict $(HELM_CHART_DIR) \
	    --set global.domain=portal.example.com \
	    --set global.azureAdTenantId=00000000-0000-0000-0000-000000000000
	helm template csa-portal $(HELM_CHART_DIR) \
	    --set global.domain=portal.example.com \
	    --set global.azureAdTenantId=00000000-0000-0000-0000-000000000000 \
	    > /dev/null
	@echo "helm-lint OK"

# --- Cleanup ---

clean: ## Remove build artifacts and caches
	-find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null
	-find . -type d -name ".ruff_cache" -exec rm -rf {} + 2>/dev/null
	-find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null
	-find . -name "*.pyc" -delete 2>/dev/null
	rm -rf .venv
	rm -rf domains/shared/dbt/target
	rm -rf domains/shared/dbt/dbt_packages
	rm -rf domains/shared/dbt/logs
	@echo "Cleaned"
