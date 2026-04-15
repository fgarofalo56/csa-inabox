.PHONY: help setup lint test validate deploy-dev deploy-prod deploy-adf prerequisites seed seed-azure clean security

# Default target
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Setup ---

setup: ## Set up development environment
	python -m venv .venv && \
	. .venv/bin/activate && \
	pip install --upgrade pip && \
	pip install -e ".[dev,governance,functions]"
	@echo ""
	@echo "Activate with: source .venv/bin/activate"

setup-win: ## Set up development environment (Windows)
	python -m venv .venv
	.venv\Scripts\pip install --upgrade pip
	.venv\Scripts\pip install -e ".[dev,governance,functions]"
	@echo ""
	@echo "Activate with: .venv\Scripts\activate"

# --- Linting ---

lint: ## Run all linters (uses pyproject.toml rule config)
	ruff check domains/ scripts/ governance/ tools/ platform/ portal/ examples/
	@echo "Python lint passed"

lint-fix: ## Auto-fix lint issues
	ruff check domains/ scripts/ governance/ tools/ platform/ portal/ examples/ --fix
	ruff format domains/ scripts/ governance/ tools/ platform/ portal/ examples/

typecheck: ## Run strict mypy on governance, tests, and all three Function apps
	mypy
	mypy domains/sharedServices/aiEnrichment/functions/function_app.py
	mypy domains/sharedServices/eventProcessing/functions/function_app.py
	mypy domains/sharedServices/secretRotation/functions/function_app.py
	@echo "mypy strict passed"

lint-bicep: ## Lint all Bicep files
	@find deploy/bicep -name "*.bicep" -not -path "*/node_modules/*" -exec sh -c 'echo "Building: {}"; bicep build {} && rm -f "$${1%.bicep}.json"' _ {} \;

lint-ps: ## Lint PowerShell scripts
	pwsh -Command "Get-ChildItem -Recurse -Filter *.ps1 | ForEach-Object { Invoke-ScriptAnalyzer -Path $$_.FullName -Severity Warning }"

security: ## Run Bandit security linter
	bandit -r governance/ domains/ scripts/ -c pyproject.toml --skip B101

# --- Testing ---

test: ## Run all tests
	pytest tests/ --tb=short -q

test-e2e: ## Run end-to-end integration tests (offline, DuckDB only)
	pytest tests/e2e/ -v --tb=short -m "not live"

test-e2e-live: ## Run all end-to-end tests (requires Azure connection)
	pytest tests/e2e/ -v --tb=short

test-dbt: ## Compile and test dbt models
	cd domains/shared/dbt && dbt compile --profiles-dir .
	cd domains/shared/dbt && dbt test --profiles-dir .

# --- Validation ---

validate: ## Run all validation gates
	pwsh -File agent-harness/gates/validate-all.ps1

validate-bicep: ## Validate Bicep templates only
	pwsh -File agent-harness/gates/validate-bicep.ps1

validate-python: ## Validate Python code only
	pwsh -File agent-harness/gates/validate-python.ps1

validate-dbt: ## Validate dbt models only
	pwsh -File agent-harness/gates/validate-dbt.ps1

# --- Terraform ---

tf-init: ## Initialize Terraform (DLZ)
	cd deploy/terraform/dlz && terraform init

tf-plan: ## Plan Terraform changes (DLZ, dev)
	cd deploy/terraform/dlz && terraform plan

tf-validate: ## Validate all Terraform configurations
	cd deploy/terraform/dlz && terraform validate
	cd deploy/terraform/dmlz && terraform validate

# --- Deployment ---

deploy-dev: ## Deploy to dev environment (what-if)
	@echo "Running what-if for all landing zones..."
	bash scripts/deploy/deploy-platform.sh --environment dev --dry-run

deploy-prod: ## Deploy to production (requires confirmation)
	@echo "Deploying to PRODUCTION..."
	bash scripts/deploy/deploy-platform.sh --environment prod

deploy-adf: ## Deploy ADF pipelines to a Data Factory instance
	bash scripts/deploy/deploy-adf.sh --factory-name $(FACTORY_NAME) --resource-group $(RESOURCE_GROUP) $(if $(DRY_RUN),--dry-run)

prerequisites: ## Validate deployment prerequisites
	bash scripts/deploy/validate-prerequisites.sh

seed: ## Load sample data via dbt seed
	cd domains/shared/dbt && dbt seed --profiles-dir .

seed-azure: ## Upload sample data to ADLS (requires --storage-account)
	python scripts/seed/load_sample_data.py --mode adls --storage-account $(STORAGE_ACCOUNT)

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
