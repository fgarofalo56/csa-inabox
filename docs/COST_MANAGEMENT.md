[Home](../README.md) > [Docs](./) > **Cost Management**

# Cost Management Guide

!!! note
**Quick Summary**: FinOps practices for CSA-in-a-Box covering cost estimation (Bicep + Terraform paths), budget guardrails per environment, CI/CD cost comments, required tagging strategy, optimization tips (reserved instances, auto-pause, storage tiering, right-sizing), and a FinOps maturity roadmap (Crawl → Walk → Run).

This document covers cost estimation, budget guardrails, and FinOps practices for the CSA-in-a-Box platform.

## 📑 Table of Contents

- [💰 Cost Estimation Approach](#-cost-estimation-approach)
    - [Bicep Path (Primary)](#bicep-path-primary)
    - [Terraform Path (Future)](#terraform-path-future)
- [🔧 Running Cost Estimates Locally](#-running-cost-estimates-locally)
    - [Prerequisites](#prerequisites)
    - [Basic Usage](#basic-usage)
    - [Understanding the Output](#understanding-the-output)
    - [Exit Codes](#exit-codes)
- [🔄 CI/CD Integration](#-cicd-integration)
    - [GitHub Actions — Cost Estimate Job](#github-actions--cost-estimate-job)
    - [Adding Cost Estimates to Other Workflows](#adding-cost-estimates-to-other-workflows)
    - [Infracost (Terraform Path)](#infracost-terraform-path)
- [🚨 Budget Thresholds and Alerts](#-budget-thresholds-and-alerts)
    - [Policy Rules](#policy-rules)
    - [Azure Cost Management Alerts](#azure-cost-management-alerts)
- [🏷️ Tagging Strategy](#️-tagging-strategy)
    - [Required Tags](#required-tags)
    - [Enforcement](#enforcement)
- [📉 Cost Optimization Tips](#-cost-optimization-tips)
    - [Reserved Instances & Savings Plans](#reserved-instances--savings-plans)
    - [Auto-Pause and Auto-Stop](#auto-pause-and-auto-stop)
    - [Spot VMs and Low-Priority Compute](#spot-vms-and-low-priority-compute)
    - [Storage Tiering](#storage-tiering)
    - [Right-Sizing](#right-sizing)
- [📊 FinOps Maturity Model](#-finops-maturity-model)
    - [Stage 1: Crawl (Current)](#stage-1-crawl-current)
    - [Stage 2: Walk](#stage-2-walk)
    - [Stage 3: Run](#stage-3-run)
- [📋 Resource-Specific Pricing Reference](#-resource-specific-pricing-reference)
- [📚 Further Reading](#-further-reading)

---

## 💰 Cost Estimation Approach

CSA-in-a-Box supports two IaC paths, each with its own cost estimation strategy.

### Bicep Path (Primary)

The primary deployment path uses Azure Bicep templates under `deploy/bicep/`. Because [Infracost](https://www.infracost.io/) does not natively support Bicep, we provide a custom script that:

1. Compiles Bicep to ARM JSON using `az bicep build --stdout`
2. Extracts resource types and counts with `jq`
3. Queries the [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) for each resource type
4. Produces a formatted cost estimate with budget comparison

**Script:** `scripts/deploy/estimate-costs.sh`

!!! important
Bicep estimates are best-effort. The Azure Retail Prices API returns list prices — actual costs depend on EA/CSP agreements, reserved instances, and consumption-based meters.

### Terraform Path (Roadmap — not implemented)

!!! warning
A parallel Terraform deployment is **on the roadmap**, not available today
(CSA-0015 / audit approval queue item AQ-0024). `deploy/terraform/` does
not exist in the repository. The `.infracost/terraform.yml` configuration
is a scaffold that will activate once Terraform modules ship. Until then,
use the Bicep path (above) for all cost analyses.

---

## 🔧 Running Cost Estimates Locally

### Prerequisites

- Azure CLI with Bicep extension (`az bicep install`)
- `jq` (JSON processor)
- `curl` (HTTP client)
- `bc` (calculator, usually pre-installed)

### Basic Usage

```bash
# Estimate costs for the DLZ
./scripts/deploy/estimate-costs.sh deploy/bicep/DLZ/main.bicep

# With parameters file
./scripts/deploy/estimate-costs.sh deploy/bicep/DLZ/main.bicep \
    --params deploy/bicep/DLZ/params.dev.json

# JSON output for scripting
./scripts/deploy/estimate-costs.sh deploy/bicep/DLZ/main.bicep \
    --format json

# Compare against a budget
./scripts/deploy/estimate-costs.sh deploy/bicep/DLZ/main.bicep \
    --budget 5000

# Specify environment (loads budget from .infracost/policy.yml)
./scripts/deploy/estimate-costs.sh deploy/bicep/DLZ/main.bicep \
    --environment dev

# Different region and currency
./scripts/deploy/estimate-costs.sh deploy/bicep/DLZ/main.bicep \
    --region westus2 --currency EUR
```

### Understanding the Output

The table output shows:

| Column        | Description                                             |
| ------------- | ------------------------------------------------------- |
| Resource Type | ARM resource type (e.g., `Storage/storageAccounts`)     |
| SKU           | Pricing SKU returned by the API                         |
| Unit $        | Per-unit retail price                                   |
| Qty           | Number of instances in the template                     |
| Monthly $     | Estimated monthly cost (unit price × hours/month × qty) |

Resources without a pricing mapping or that cannot be found in the API are flagged as warnings.

### Exit Codes

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| 0    | Success, within budget (or no budget set) |
| 1    | Script error (missing file, failed build) |
| 2    | Over budget (table mode with `--budget`)  |

---

## 🔄 CI/CD Integration

### GitHub Actions — Cost Estimate Job

The `bicep-whatif.yml` workflow includes a `cost-estimate` job that runs after the what-if analysis on every PR that modifies Bicep files. It:

1. Compiles each changed landing zone's Bicep to ARM JSON
2. Runs `estimate-costs.sh` in JSON mode
3. Posts a cost summary as a PR comment

The cost estimate job uses the environment-specific budget from `.infracost/policy.yml`. If the estimate exceeds the budget, the job logs a warning but does not block the PR (to avoid false-positive rejections from list-price estimates).

### Adding Cost Estimates to Other Workflows

```yaml
- name: Run Cost Estimate
  run: |
      chmod +x scripts/deploy/estimate-costs.sh
      ./scripts/deploy/estimate-costs.sh deploy/bicep/DLZ/main.bicep \
        --format json \
        --environment ${{ vars.ENVIRONMENT || 'dev' }} \
        --budget ${{ vars.COST_BUDGET || '5000' }}
```

### Infracost (Terraform Path)

When the Terraform modules are available:

```yaml
- name: Setup Infracost
  uses: infracost/actions/setup@v3
  with:
      api-key: ${{ secrets.INFRACOST_API_KEY }}

- name: Run Infracost
  run: |
      infracost breakdown \
        --config-file .infracost/terraform.yml \
        --format json \
        --out-file /tmp/infracost.json

- name: Post Infracost Comment
  uses: infracost/actions/comment@v1
  with:
      path: /tmp/infracost.json
      behavior: update
```

---

## 🚨 Budget Thresholds and Alerts

Budget thresholds are defined in `.infracost/policy.yml`:

| Environment | Monthly Budget | Alert Threshold |
| ----------- | -------------- | --------------- |
| dev         | $5,000         | 80%             |
| staging     | $10,000        | 80%             |
| prod        | $25,000        | 75%             |

### Policy Rules

The policy file also enforces cost guardrails:

| Rule                       | Environment | Action | Description                                |
| -------------------------- | ----------- | ------ | ------------------------------------------ |
| `no-premium-in-dev`        | dev         | warn   | Flag Premium SKUs in dev                   |
| `no-multi-region-dev`      | dev         | warn   | Flag RA-GZRS storage in dev                |
| `enforce-serverless-dev`   | dev         | warn   | Prefer serverless Cosmos DB in dev         |
| `max-databricks-nodes-dev` | dev         | deny   | Limit Databricks cluster nodes to 4 in dev |
| `max-adx-sku-dev`          | dev         | warn   | Require Dev/Test ADX SKU in dev            |

### Azure Cost Management Alerts

In addition to pre-deployment estimates, configure Azure Cost Management alerts for runtime monitoring:

```bash
# Create a budget in Azure Cost Management
az consumption budget create \
    --budget-name "csa-dev-monthly" \
    --amount 5000 \
    --category cost \
    --time-grain Monthly \
    --start-date "2024-01-01" \
    --end-date "2025-12-31" \
    --resource-group "rg-dlz-dev-*" \
    --notifications '[{
        "enabled": true,
        "operator": "GreaterThanOrEqualTo",
        "threshold": 80,
        "contactEmails": ["platform-team@contoso.com"],
        "thresholdType": "Actual"
    }]'
```

---

## 🏷️ Tagging Strategy

All CSA-in-a-Box resources must include cost-attribution tags. These are enforced in the Bicep templates via the `tagsDefault` variable in each landing zone's `main.bicep`.

### Required Tags

| Tag              | Purpose                 | Example Values              |
| ---------------- | ----------------------- | --------------------------- |
| `environment`    | Deployment environment  | `dev`, `staging`, `prod`    |
| `CostCenter`     | Billing/chargeback code | `CSA-Platform`, `DataEng`   |
| `Owner`          | Team or project owner   | `Platform Team`             |
| `Project`        | Project name            | `Azure Demo ALZ & CSA`      |
| `PrimaryContact` | Technical contact email | `platform-team@contoso.com` |
| `Toolkit`        | IaC tool used           | `Bicep`, `Terraform`        |

### Enforcement

Tags are defined in the `tagsDefault` variable in each landing zone and merged with resource-specific tags:

```bicep
var tagsDefault = {
    Owner: 'Azure Landing Zone & Cloud Scale Analytics Scenario'
    Project: 'Azure Demo ALZ & CSA'
    environment: environment
    Toolkit: 'Bicep'
    PrimaryContact: primaryContact
    CostCenter: costCenter
}
```

Azure Policy can further enforce tagging at the subscription or management group level:

```json
{
    "if": {
        "field": "[concat('tags[', 'CostCenter', ']')]",
        "exists": "false"
    },
    "then": {
        "effect": "deny"
    }
}
```

---

## 📉 Cost Optimization Tips

### Reserved Instances & Savings Plans

| Service       | Savings Opportunity                                  |
| ------------- | ---------------------------------------------------- |
| Databricks    | Pre-purchase DBU commit (1-year: ~25%, 3-year: ~40%) |
| Cosmos DB     | Reserved capacity for provisioned throughput         |
| Data Explorer | Reserved capacity for cluster compute                |
| VMs (SHIR)    | Reserved Instances for always-on Integration Runtime |

### Auto-Pause and Auto-Stop

```bicep
// Synapse SQL Pools — auto-pause after 60 minutes of inactivity
autopauseDelayInMinutes: 60

// ADX Dev clusters — auto-stop enabled
enableAutoStop: true
```

In dev/staging, always enable auto-pause for:

- [ ] Synapse dedicated SQL pools
- [ ] Databricks clusters (via cluster policies)
- [ ] Data Explorer clusters (Dev SKU auto-stop)

### Spot VMs and Low-Priority Compute

- Use Spot VMs for Databricks worker nodes in dev/test
- Use Low-Priority nodes for Synapse Spark pools in dev/test
- Typical savings: 60-90% over pay-as-you-go

### Storage Tiering

| Tier    | Use Case                     | Relative Cost |
| ------- | ---------------------------- | ------------- |
| Hot     | Frequently accessed data     | 1.0x          |
| Cool    | Infrequent access (30+ days) | ~0.5x         |
| Archive | Rarely accessed (180+ days)  | ~0.1x         |

Implement lifecycle management policies for each lake zone:

```json
{
    "rules": [
        {
            "name": "archive-old-data",
            "type": "Lifecycle",
            "definition": {
                "actions": {
                    "baseBlob": {
                        "tierToCool": {
                            "daysAfterModificationGreaterThan": 30
                        },
                        "tierToArchive": {
                            "daysAfterModificationGreaterThan": 180
                        }
                    }
                },
                "filters": {
                    "blobTypes": ["blockBlob"],
                    "prefixMatch": ["raw/", "enriched/"]
                }
            }
        }
    ]
}
```

### Right-Sizing

- **Event Hubs:** Start with Standard tier (1 TU); scale up only when throughput exceeds 1 MB/s ingress
- **Stream Analytics:** Start with 3 SUs; monitor SU% utilization and adjust
- **Functions:** Use Consumption plan in dev; switch to Premium only for VNet integration or sustained load
- **Data Explorer:** Use `Dev(No SLA)_Standard_E2a_v4` for dev; move to `Standard_E8ads_v5` for production

---

## 📊 FinOps Maturity Model

### Stage 1: Crawl (Current)

- [x] Pre-deployment cost estimation via `estimate-costs.sh`
- [x] Budget thresholds in `.infracost/policy.yml`
- [x] Required cost-attribution tags on all resources
- [x] PR-level cost impact comments
- [ ] Azure Cost Management budgets and alerts

### Stage 2: Walk

- [ ] Terraform path with native Infracost support
- [ ] Historical cost tracking (Infracost Cloud or Azure Cost Export)
- [ ] Automated anomaly detection (Azure Cost Alerts)
- [ ] Monthly cost review cadence with team
- [ ] Showback reports by `CostCenter` tag

### Stage 3: Run

- [ ] Chargeback model across domains/teams
- [ ] Reserved instance and savings plan optimization
- [ ] Automated right-sizing recommendations
- [ ] Cost-per-pipeline / cost-per-query attribution
- [ ] Integration with organizational FinOps tooling

---

## 📋 Resource-Specific Pricing Reference

Quick reference for the CSA services tracked by `estimate-costs.sh`:

| Service           | ARM Type                                       | Default SKU (Dev)            | Pricing Model        |
| ----------------- | ---------------------------------------------- | ---------------------------- | -------------------- |
| Storage Account   | `Microsoft.Storage/storageAccounts`            | Standard_LRS                 | Per GB stored + ops  |
| Event Hubs        | `Microsoft.EventHub/namespaces`                | Standard (1 TU)              | Per TU/hour + events |
| Data Factory      | `Microsoft.DataFactory/factories`              | N/A (pay-per-pipeline)       | Per activity run     |
| Databricks        | `Microsoft.Databricks/workspaces`              | Premium                      | Per DBU/hour         |
| Data Explorer     | `Microsoft.Kusto/clusters`                     | Dev(No SLA)\_Standard_E2a_v4 | Per cluster/hour     |
| Key Vault         | `Microsoft.KeyVault/vaults`                    | Standard                     | Per operation        |
| Cosmos DB         | `Microsoft.DocumentDB/databaseAccounts`        | Serverless                   | Per RU + storage     |
| Azure Functions   | `Microsoft.Web/sites`                          | Consumption / EP1            | Per execution + GB-s |
| Stream Analytics  | `Microsoft.StreamAnalytics/streamingjobs`      | Standard (3 SU)              | Per SU/hour          |
| Log Analytics     | `Microsoft.OperationalInsights/workspaces`     | Per GB                       | Per GB ingested      |
| Machine Learning  | `Microsoft.MachineLearningServices/workspaces` | Basic                        | Per compute/hour     |
| Synapse Analytics | `Microsoft.Synapse/workspaces`                 | Serverless SQL Pool          | Per TB processed     |

---

## 📚 Further Reading

- [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/)
- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
- [Infracost Documentation](https://www.infracost.io/docs/)
- [FinOps Foundation](https://www.finops.org/)
- [Azure Cost Management Best Practices](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/cost-mgt-best-practices)

---

## 🔗 Related Documentation

- [Production Checklist](PRODUCTION_CHECKLIST.md) — Pre-production readiness checklist
- [Platform Services](PLATFORM_SERVICES.md) — Platform services reference and SKU details
- [Multi-Tenant](MULTI_TENANT.md) — Multi-tenant deployment with per-tenant cost attribution
