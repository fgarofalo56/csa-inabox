# =============================================================================
# Data Explorer (Kusto) Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/dataexplorer/dataexplorer.bicep
# =============================================================================

variable "cluster_name" {
  description = "Name of the Kusto cluster."
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

# --- Cluster Configuration ---

variable "sku_name" {
  description = "SKU name for the cluster."
  type        = string
  default     = "Dev(No SLA)_Standard_E2a_v4"
}

variable "sku_capacity" {
  description = "Number of instances in the cluster."
  type        = number
  default     = 1
}

variable "streaming_ingestion_enabled" {
  description = "Enable streaming ingestion."
  type        = bool
  default     = true
}

variable "auto_stop_enabled" {
  description = "Enable auto-stop when idle."
  type        = bool
  default     = true
}

variable "double_encryption_enabled" {
  description = "Enable double encryption at rest."
  type        = bool
  default     = true
}

variable "public_network_access_enabled" {
  description = "Enable public network access."
  type        = bool
  default     = false
}

# --- Databases ---

variable "databases" {
  description = "List of databases to create."
  type = list(object({
    name               = string
    hot_cache_period   = optional(string, "P31D")
    soft_delete_period = optional(string, "P365D")
  }))
  default = []
}

# --- Private Endpoints ---

variable "private_endpoints" {
  description = "List of private endpoints for the cluster."
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

variable "cmk_key_vault_key_id" {
  description = "Key Vault Key ID for CMK encryption."
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
  description = "Resource ID of the user-assigned managed identity for CMK."
  type        = string
  default     = ""
}
