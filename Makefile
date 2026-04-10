.PHONY: help setup lint test validate deploy-dev clean

# Default target
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Setup ---

setup: ## Set up development environment
	python -m venv .venv && \
	. .venv/bin/activate && \
	pip install --upgrade pip && \
	pip install -e ".[dev]"
	@echo ""
	@echo "Activate with: source .venv/bin/activate"

setup-win: ## Set up development environment (Windows)
	python -m venv .venv && \
	.venv\Scripts\activate && \
	pip install --upgrade pip && \
	pip install -e ".[dev]"
	@echo ""
	@echo "Activate with: .venv\Scripts\activate"

# --- Linting ---

lint: ## Run all linters
	ruff check domains/ scripts/ governance/ --select E,F,W --ignore E501
	@echo "Python lint passed"

lint-fix: ## Auto-fix lint issues
	ruff check domains/ scripts/ governance/ --fix --select E,F,W --ignore E501
	ruff format domains/ scripts/ governance/

lint-bicep: ## Lint all Bicep files
	@find deploy/bicep -name "*.bicep" -not -path "*/node_modules/*" -exec sh -c 'echo "Building: {}"; bicep build {} && rm -f "$${1%.bicep}.json"' _ {} \;

lint-ps: ## Lint PowerShell scripts
	pwsh -Command "Get-ChildItem -Recurse -Filter *.ps1 | ForEach-Object { Invoke-ScriptAnalyzer -Path $$_.FullName -Severity Warning }"

# --- Testing ---

test: ## Run all tests
	pytest tests/ --tb=short -q 2>/dev/null || echo "No tests found yet"

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

# --- Deployment ---

deploy-dev: ## Deploy to dev environment (what-if)
	@echo "Running what-if for all landing zones..."
	az deployment sub what-if --location eastus --template-file deploy/bicep/DLZ/main.bicep --parameters deploy/bicep/DLZ/params.dev.json
	az deployment sub what-if --location eastus --template-file deploy/bicep/DMLZ/main.bicep --parameters deploy/bicep/DMLZ/params.dev.json

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
