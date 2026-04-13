# =============================================================================
# DMLZ (Data Management Landing Zone) — Variables
# Mirrors parameters from: deploy/bicep/DMLZ/main.bicep
# =============================================================================

# --- General ---

variable "subscription_id" {
  description = "Azure subscription ID for the DMLZ."
  type        = string
}

variable "location" {
  description = "Azure region for all resources."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev, tst, uat, stg, prod)."
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "tst", "uat", "stg", "prod"], var.environment)
    error_message = "Must be dev, tst, uat, stg, or prod."
  }
}

variable "prefix" {
  description = "Prefix for all resources."
  type        = string
  default     = "admlz"
}

variable "primary_contact" {
  description = "Primary technical contact."
  type        = string
  default     = "platform-team@contoso.com"
}

variable "cost_center" {
  description = "Cost center or billing code."
  type        = string
  default     = "CSA-Platform"
}

variable "extra_tags" {
  description = "Additional tags to merge with defaults."
  type        = map(string)
  default     = {}
}

# --- Feature Toggles ---

variable "deploy_governance" {
  description = "Deploy Purview governance resources."
  type        = bool
  default     = true
}

variable "deploy_keyvault" {
  description = "Deploy Key Vault."
  type        = bool
  default     = true
}

variable "deploy_networking" {
  description = "Deploy networking (VNets, DNS zones)."
  type        = bool
  default     = true
}

variable "deploy_monitoring" {
  description = "Deploy Log Analytics and monitoring."
  type        = bool
  default     = true
}

variable "deploy_security" {
  description = "Deploy CMK identity and key."
  type        = bool
  default     = false
}

variable "deploy_databricks" {
  description = "Deploy governance Databricks workspace."
  type        = bool
  default     = false
}

# --- Cross-cutting ---

variable "log_analytics_workspace_id" {
  description = "Resource ID of an external Log Analytics workspace. Leave empty to use the one created by this deployment."
  type        = string
  default     = ""
}

variable "enable_resource_lock" {
  description = "Enable CanNotDelete resource locks."
  type        = bool
  default     = true
}

# --- Networking ---

variable "vnet_address_space" {
  description = "Address space for the DMLZ VNet."
  type        = list(string)
  default     = ["10.1.0.0/16"]
}

variable "subnets" {
  description = "Subnets for the DMLZ VNet."
  type = list(object({
    name                                          = string
    address_prefixes                               = list(string)
    service_endpoints                              = optional(list(string), [])
    private_endpoint_network_policies             = optional(string, "Disabled")
    private_link_service_network_policies_enabled = optional(bool, false)
    delegation = optional(object({
      name         = string
      service_name = string
      actions      = list(string)
    }), null)
  }))
  default = [
    {
      name             = "default"
      address_prefixes = ["10.1.0.0/24"]
    },
    {
      name             = "private-endpoints"
      address_prefixes = ["10.1.1.0/24"]
    }
  ]
}

variable "private_dns_zones" {
  description = "Private DNS zones to create."
  type        = list(string)
  default = [
    "privatelink.blob.core.windows.net",
    "privatelink.dfs.core.windows.net",
    "privatelink.vaultcore.azure.net",
    "privatelink.documents.azure.com",
    "privatelink.azuredatabricks.net",
    "privatelink.sql.azuresynapse.net",
    "privatelink.dev.azuresynapse.net",
    "privatelink.datafactory.azure.net",
    "privatelink.adf.azure.com",
    "privatelink.servicebus.windows.net",
    "privatelink.kusto.windows.net",
    "privatelink.api.azureml.ms",
    "privatelink.azurewebsites.net",
    "privatelink.purview.azure.com",
    "privatelink.purviewstudio.azure.com"
  ]
}

# --- Key Vault ---

variable "keyvault_name" {
  description = "Name of the Key Vault."
  type        = string
  default     = ""
}

variable "private_endpoint_subnet_id" {
  description = "Subnet ID for private endpoints. Auto-derived if networking is deployed."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_keyvault" {
  description = "Private DNS zone ID for Key Vault."
  type        = string
  default     = ""
}

# --- Purview ---

variable "purview_account_name" {
  description = "Name of the Purview account."
  type        = string
  default     = ""
}

variable "purview_configure_kafka" {
  description = "Configure Kafka for Purview."
  type        = bool
  default     = false
}

# --- Databricks ---

variable "databricks_vnet_id" {
  description = "VNet ID for Databricks VNet injection."
  type        = string
  default     = ""
}

variable "databricks_public_subnet_name" {
  description = "Public subnet name for Databricks."
  type        = string
  default     = "databricks-gov-public"
}

variable "databricks_private_subnet_name" {
  description = "Private subnet name for Databricks."
  type        = string
  default     = "databricks-gov-private"
}

variable "private_dns_zone_id_databricks" {
  description = "Private DNS zone ID for Databricks."
  type        = string
  default     = ""
}

# --- Monitoring ---

variable "log_analytics_workspace_name" {
  description = "Name for the Log Analytics workspace created by this deployment."
  type        = string
  default     = ""
}

variable "log_analytics_retention_in_days" {
  description = "Data retention in days."
  type        = number
  default     = 90
}
