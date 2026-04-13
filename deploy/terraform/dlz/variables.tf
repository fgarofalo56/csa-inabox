# =============================================================================
# DLZ (Data Landing Zone) — Variables
# Mirrors parameters from: deploy/bicep/DLZ/main.bicep
# =============================================================================

# --- General ---

variable "subscription_id" {
  description = "Azure subscription ID for the DLZ."
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
  default     = "dlz"
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

variable "deploy_cosmosdb" {
  description = "Deploy Cosmos DB."
  type        = bool
  default     = true
}

variable "deploy_storage" {
  description = "Deploy Data Lake storage."
  type        = bool
  default     = true
}

variable "deploy_synapse" {
  description = "Deploy Synapse workspace."
  type        = bool
  default     = false
}

variable "deploy_databricks" {
  description = "Deploy Databricks workspace."
  type        = bool
  default     = false
}

variable "deploy_data_factory" {
  description = "Deploy Data Factory."
  type        = bool
  default     = false
}

variable "deploy_event_hubs" {
  description = "Deploy Event Hubs."
  type        = bool
  default     = false
}

variable "deploy_data_explorer" {
  description = "Deploy Data Explorer (Kusto)."
  type        = bool
  default     = false
}

variable "deploy_machine_learning" {
  description = "Deploy Machine Learning workspace."
  type        = bool
  default     = false
}

variable "deploy_app_insights" {
  description = "Deploy Application Insights."
  type        = bool
  default     = false
}

variable "deploy_functions" {
  description = "Deploy Azure Functions."
  type        = bool
  default     = false
}

variable "deploy_stream_analytics" {
  description = "Deploy Stream Analytics."
  type        = bool
  default     = false
}

# --- Cross-cutting ---

variable "log_analytics_workspace_id" {
  description = "Resource ID of the Log Analytics workspace for diagnostics."
  type        = string
  default     = ""
}

variable "enable_cmk" {
  description = "Enable Customer-Managed Key encryption globally."
  type        = bool
  default     = false
}

variable "enable_resource_lock" {
  description = "Enable CanNotDelete resource locks."
  type        = bool
  default     = true
}

# --- Private Endpoint Subnet ---

variable "private_endpoint_subnet_id" {
  description = "Subnet ID for private endpoints."
  type        = string
  default     = ""
}

# --- CMK Security ---

variable "cmk_key_vault_key_id" {
  description = "Key Vault Key ID for CMK (used across modules)."
  type        = string
  default     = ""
}

variable "cmk_key_vault_id" {
  description = "Resource ID of the Key Vault containing the CMK key."
  type        = string
  default     = ""
}

variable "cmk_key_name" {
  description = "Name of the CMK key in Key Vault."
  type        = string
  default     = ""
}

variable "cmk_identity_id" {
  description = "User-assigned identity ID for CMK operations."
  type        = string
  default     = ""
}

# --- Private DNS Zone IDs ---

variable "private_dns_zone_id_blob" {
  description = "Private DNS zone ID for blob storage."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_dfs" {
  description = "Private DNS zone ID for DFS."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_cosmosdb" {
  description = "Private DNS zone ID for Cosmos DB."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_databricks" {
  description = "Private DNS zone ID for Databricks."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_synapse_sql" {
  description = "Private DNS zone ID for Synapse SQL."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_synapse_dev" {
  description = "Private DNS zone ID for Synapse Dev."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_datafactory" {
  description = "Private DNS zone ID for Data Factory."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_adf_portal" {
  description = "Private DNS zone ID for ADF portal."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_eventhubs" {
  description = "Private DNS zone ID for Event Hubs."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_kusto" {
  description = "Private DNS zone ID for Data Explorer."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_ml" {
  description = "Private DNS zone ID for Machine Learning."
  type        = string
  default     = ""
}

variable "private_dns_zone_id_functions" {
  description = "Private DNS zone ID for Functions."
  type        = string
  default     = ""
}

# --- Storage Config ---

variable "storage_account_name" {
  description = "Storage account name for Data Lake."
  type        = string
  default     = ""
}

variable "storage_replication_type" {
  description = "Storage replication type."
  type        = string
  default     = "ZRS"
}

variable "storage_file_systems" {
  description = "ADLS Gen2 file systems to create."
  type        = list(string)
  default     = ["raw", "curated", "workspace"]
}

# --- Cosmos DB Config ---

variable "cosmosdb_account_name" {
  description = "Cosmos DB account name."
  type        = string
  default     = ""
}

variable "cosmosdb_consistency_level" {
  description = "Consistency level."
  type        = string
  default     = "Session"
}

# --- Synapse Config ---

variable "synapse_sql_admin_password" {
  description = "Synapse SQL admin password."
  type        = string
  sensitive   = true
  default     = ""
}

# --- Databricks Config ---

variable "databricks_vnet_id" {
  description = "VNet ID for Databricks VNet injection."
  type        = string
  default     = ""
}

variable "databricks_public_subnet_name" {
  description = "Public subnet name for Databricks."
  type        = string
  default     = "databricks-public"
}

variable "databricks_private_subnet_name" {
  description = "Private subnet name for Databricks."
  type        = string
  default     = "databricks-private"
}

# --- Event Hubs Config ---

variable "event_hubs" {
  description = "Event hubs to create."
  type = list(object({
    name                   = string
    partition_count        = optional(number, 4)
    message_retention_days = optional(number, 7)
    consumer_groups        = optional(list(string), ["analytics"])
  }))
  default = []
}

# --- Data Explorer Config ---

variable "data_explorer_sku" {
  description = "SKU for Data Explorer cluster."
  type        = string
  default     = "Dev(No SLA)_Standard_E2a_v4"
}

variable "data_explorer_databases" {
  description = "Databases to create in Data Explorer."
  type = list(object({
    name               = string
    hot_cache_period   = optional(string, "P31D")
    soft_delete_period = optional(string, "P365D")
  }))
  default = []
}

# --- Functions Config ---

variable "functions_runtime" {
  description = "Functions runtime."
  type        = string
  default     = "python"
}

variable "functions_plan_sku" {
  description = "Functions App Service Plan SKU."
  type        = string
  default     = "EP1"
}

# --- Stream Analytics Config ---

variable "stream_analytics_streaming_units" {
  description = "Number of streaming units."
  type        = number
  default     = 3
}
