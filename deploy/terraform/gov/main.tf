# CSA-in-a-Box — Azure Government Terraform Configuration
# Deploys the complete Fabric-in-a-Box platform to Azure Government

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 2.47"
    }
  }

  backend "azurerm" {
    # Configure for Azure Government storage
    # environment = "usgovernment"  # Uncomment for Gov
  }
}

# ─── Provider Configuration ────────────────────────────────────────────────

provider "azurerm" {
  environment = "usgovernment"

  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
    log_analytics_workspace {
      permanently_delete_on_destroy = false
    }
  }
}

provider "azuread" {
  environment = "usgovernment"
}

# ─── Variables ──────────────────────────────────────────────────────────────

variable "location" {
  description = "Azure Government region"
  type        = string
  default     = "usgovvirginia"

  validation {
    condition     = contains(["usgovvirginia", "usgovarizona", "usgovtexas", "usgoviowa"], var.location)
    error_message = "Must be a valid Azure Government region."
  }
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "tst", "stg", "prod"], var.environment)
    error_message = "Must be dev, tst, stg, or prod."
  }
}

variable "prefix" {
  description = "Resource naming prefix"
  type        = string
  default     = "csa"

  validation {
    condition     = length(var.prefix) >= 2 && length(var.prefix) <= 10
    error_message = "Prefix must be 2-10 characters."
  }
}

variable "enable_fedramp_high" {
  description = "Enable FedRAMP High compliance controls"
  type        = bool
  default     = true
}

variable "data_classification" {
  description = "Default data classification level"
  type        = string
  default     = "CUI"

  validation {
    condition     = contains(["CUI", "FOUO", "PII", "PHI", "Public"], var.data_classification)
    error_message = "Must be CUI, FOUO, PII, PHI, or Public."
  }
}

variable "impact_level" {
  description = "Impact level for DoD workloads"
  type        = string
  default     = "IL4"

  validation {
    condition     = contains(["IL2", "IL4", "IL5"], var.impact_level)
    error_message = "Must be IL2, IL4, or IL5."
  }
}

variable "deploy_dlz" {
  description = "Deploy Data Landing Zone resources"
  type        = bool
  default     = true
}

variable "deploy_dmlz" {
  description = "Deploy Data Management Landing Zone resources"
  type        = bool
  default     = true
}

variable "deploy_streaming" {
  description = "Deploy streaming infrastructure (Event Hubs, ADX)"
  type        = bool
  default     = true
}

variable "deploy_ai" {
  description = "Deploy AI services (OpenAI, ML)"
  type        = bool
  default     = true
}

variable "deploy_oss" {
  description = "Deploy open-source alternatives on AKS"
  type        = bool
  default     = false
}

variable "enable_hipaa" {
  description = "Enable HIPAA compliance controls"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

# ─── Locals ─────────────────────────────────────────────────────────────────

locals {
  base_name = lower("${var.prefix}-${var.environment}")

  gov_endpoints = {
    active_directory = "https://login.microsoftonline.us"
    resource_manager = "https://management.usgovcloudapi.net"
    storage_suffix   = "core.usgovcloudapi.net"
    sql_suffix       = "database.usgovcloudapi.net"
    databricks       = "databricks.azure.us"
    key_vault_suffix = "vault.usgovcloudapi.net"
  }

  compliance_tags = merge(var.tags, {
    FedRAMP_Level        = var.enable_fedramp_high ? "High" : "Moderate"
    FISMA_Impact         = "High"
    Data_Classification  = var.data_classification
    Impact_Level         = var.impact_level
    Compliance_Framework = "NIST-800-53-Rev5"
    Cloud_Environment    = "AzureUSGovernment"
    Deployed_By          = "CSA-in-a-Box"
    HIPAA_Compliant      = var.enable_hipaa ? "Yes" : "No"
  })
}

# ─── Resource Groups ────────────────────────────────────────────────────────

resource "azurerm_resource_group" "platform" {
  name     = "rg-${local.base_name}-platform-${var.location}"
  location = var.location
  tags     = local.compliance_tags
}

resource "azurerm_resource_group" "dlz" {
  count    = var.deploy_dlz ? 1 : 0
  name     = "rg-${local.base_name}-dlz-${var.location}"
  location = var.location
  tags     = local.compliance_tags
}

resource "azurerm_resource_group" "dmlz" {
  count    = var.deploy_dmlz ? 1 : 0
  name     = "rg-${local.base_name}-dmlz-${var.location}"
  location = var.location
  tags     = local.compliance_tags
}

resource "azurerm_resource_group" "streaming" {
  count    = var.deploy_streaming ? 1 : 0
  name     = "rg-${local.base_name}-streaming-${var.location}"
  location = var.location
  tags     = local.compliance_tags
}

resource "azurerm_resource_group" "ai" {
  count    = var.deploy_ai ? 1 : 0
  name     = "rg-${local.base_name}-ai-${var.location}"
  location = var.location
  tags     = local.compliance_tags
}

# ─── Core Platform ──────────────────────────────────────────────────────────

resource "azurerm_log_analytics_workspace" "main" {
  name                       = "${local.base_name}-logs"
  location                   = azurerm_resource_group.platform.location
  resource_group_name        = azurerm_resource_group.platform.name
  sku                        = "PerGB2018"
  retention_in_days          = var.enable_fedramp_high ? 365 : 90
  internet_ingestion_enabled = false
  internet_query_enabled     = false
  tags                       = local.compliance_tags
}

resource "azurerm_key_vault" "main" {
  name                          = "${local.base_name}-kv"
  location                      = azurerm_resource_group.platform.location
  resource_group_name           = azurerm_resource_group.platform.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "premium" # HSM-backed for FedRAMP
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  enable_rbac_authorization     = true
  public_network_access_enabled = false
  tags                          = local.compliance_tags

  network_acls {
    default_action = "Deny"
    bypass         = "AzureServices"
  }
}

# ─── Data Landing Zone ──────────────────────────────────────────────────────

resource "azurerm_storage_account" "dlz" {
  count                           = var.deploy_dlz ? 1 : 0
  name                            = replace("${local.base_name}stor", "-", "")
  resource_group_name             = azurerm_resource_group.dlz[0].name
  location                        = azurerm_resource_group.dlz[0].location
  account_tier                    = "Standard"
  account_replication_type        = var.environment == "prod" ? "GRS" : "LRS"
  account_kind                    = "StorageV2"
  is_hns_enabled                  = true # ADLS Gen2
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  public_network_access_enabled   = false
  infrastructure_encryption_enabled = true
  tags                            = local.compliance_tags

  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
  }

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
    change_feed_enabled           = true
    change_feed_retention_in_days = 90
  }
}

resource "azurerm_storage_container" "medallion" {
  for_each              = var.deploy_dlz ? toset(["bronze", "silver", "gold", "sandbox", "staging"]) : toset([])
  name                  = each.key
  storage_account_name  = azurerm_storage_account.dlz[0].name
  container_access_type = "private"
}

# ─── Data Sources ───────────────────────────────────────────────────────────

data "azurerm_client_config" "current" {}

# ─── Outputs ────────────────────────────────────────────────────────────────

output "platform_resource_group" {
  value = azurerm_resource_group.platform.name
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.main.id
}

output "gov_endpoints" {
  value = local.gov_endpoints
}

output "storage_account_name" {
  value = var.deploy_dlz ? azurerm_storage_account.dlz[0].name : ""
}
