# =============================================================================
# Synapse Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/synapse/synapse.bicep
# =============================================================================

variable "workspace_name" {
  description = "Name of the Synapse workspace."
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group."
  type        = string
}

variable "location" {
  description = "Azure region for all resources."
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}

# --- Workspace Configuration ---

variable "storage_data_lake_gen2_filesystem_id" {
  description = "Resource ID of the default ADLS Gen2 filesystem."
  type        = string
}

variable "sql_administrator_login" {
  description = "SQL administrator login name."
  type        = string
  default     = "SqlServerMainUser"
}

variable "sql_administrator_login_password" {
  description = "SQL administrator password."
  type        = string
  sensitive   = true
}

variable "managed_virtual_network_enabled" {
  description = "Enable managed virtual network."
  type        = bool
  default     = true
}

variable "data_exfiltration_protection_enabled" {
  description = "Enable data exfiltration protection."
  type        = bool
  default     = true
}

variable "public_network_access_enabled" {
  description = "Enable public network access."
  type        = bool
  default     = false
}

variable "managed_resource_group_name" {
  description = "Name of the managed resource group."
  type        = string
  default     = ""
}

variable "purview_id" {
  description = "Purview resource ID for lineage integration."
  type        = string
  default     = ""
}

variable "compute_subnet_id" {
  description = "Subnet ID for Synapse compute."
  type        = string
  default     = ""
}

# --- SQL Pool ---

variable "deploy_sql_pool" {
  description = "Deploy a dedicated SQL pool."
  type        = bool
  default     = true
}

variable "sql_pool_name" {
  description = "Name of the SQL pool."
  type        = string
  default     = "sqlPool001"
}

variable "sql_pool_sku" {
  description = "SKU for the SQL pool."
  type        = string
  default     = "DW100c"
}

# --- AAD Admin ---

variable "aad_admin_login" {
  description = "AAD admin login name."
  type        = string
  default     = ""
}

variable "aad_admin_object_id" {
  description = "AAD admin group/user object ID."
  type        = string
  default     = ""
}

# --- Private Endpoints ---

variable "private_endpoints_sql" {
  description = "Private endpoints for Sql subresource."
  type = list(object({
    name                = string
    subnet_id           = string
    private_dns_zone_id = optional(string, "")
  }))
  default = []
}

variable "private_endpoints_sql_ondemand" {
  description = "Private endpoints for SqlOnDemand subresource."
  type = list(object({
    name                = string
    subnet_id           = string
    private_dns_zone_id = optional(string, "")
  }))
  default = []
}

variable "private_endpoints_dev" {
  description = "Private endpoints for Dev subresource."
  type = list(object({
    name                = string
    subnet_id           = string
    private_dns_zone_id = optional(string, "")
  }))
  default = []
}

# --- Diagnostics ---

variable "log_analytics_workspace_id" {
  description = "Resource ID of the Log Analytics workspace. Empty to skip diagnostics."
  type        = string
  default     = ""
}

# --- Resource Lock ---

variable "enable_resource_lock" {
  description = "Attach a CanNotDelete resource lock."
  type        = bool
  default     = true
}

# --- CMK Encryption ---

variable "enable_cmk" {
  description = "Enable Customer-Managed Key encryption."
  type        = bool
  default     = false
}

variable "cmk_key_name" {
  description = "Key name in Key Vault for CMK. Required when enable_cmk is true."
  type        = string
  default     = ""
}

variable "cmk_key_vault_url" {
  description = "Key Vault URI for CMK. Required when enable_cmk is true."
  type        = string
  default     = ""
}
