# =============================================================================
# Cosmos DB Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/cosmos/cosmosdb.bicep
# =============================================================================

variable "account_name" {
  description = "Name of the Cosmos DB account."
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group."
  type        = string
}

variable "location" {
  description = "Azure region for the primary location."
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}

# --- Cosmos DB Configuration ---

variable "kind" {
  description = "Kind of Cosmos DB account (GlobalDocumentDB, MongoDB)."
  type        = string
  default     = "GlobalDocumentDB"
}

variable "consistency_level" {
  description = "Default consistency level."
  type        = string
  default     = "Session"
  validation {
    condition     = contains(["Strong", "Eventual", "BoundedStaleness", "Session", "ConsistentPrefix"], var.consistency_level)
    error_message = "Must be Strong, Eventual, BoundedStaleness, Session, or ConsistentPrefix."
  }
}

variable "enable_automatic_failover" {
  description = "Enable automatic failover."
  type        = bool
  default     = false
}

variable "enable_multiple_write_locations" {
  description = "Enable multi-master (multi-region writes)."
  type        = bool
  default     = false
}

variable "enable_analytical_storage" {
  description = "Enable analytical storage."
  type        = bool
  default     = false
}

variable "enable_free_tier" {
  description = "Enable free tier."
  type        = bool
  default     = false
}

variable "secondary_location" {
  description = "Optional secondary region for geo-replication."
  type        = string
  default     = ""
}

variable "zone_redundancy_enabled" {
  description = "Enable zone redundancy for each location."
  type        = bool
  default     = true
}

variable "public_network_access_enabled" {
  description = "Allow public network access."
  type        = bool
  default     = false
}

variable "local_authentication_disabled" {
  description = "Disable local authentication (use AAD instead)."
  type        = bool
  default     = true
}

variable "disable_key_based_metadata_write_access" {
  description = "Disable key-based metadata write access."
  type        = bool
  default     = false
}

# --- Backup ---

variable "backup_type" {
  description = "Backup type: Continuous or Periodic."
  type        = string
  default     = "Continuous"
  validation {
    condition     = contains(["Continuous", "Periodic"], var.backup_type)
    error_message = "Must be Continuous or Periodic."
  }
}

variable "continuous_backup_tier" {
  description = "Continuous backup tier (Continuous7Days, Continuous30Days)."
  type        = string
  default     = "Continuous30Days"
}

variable "backup_interval_in_minutes" {
  description = "Backup interval for periodic mode."
  type        = number
  default     = 240
}

variable "backup_retention_in_hours" {
  description = "Backup retention for periodic mode."
  type        = number
  default     = 720
}

# --- Default Database ---

variable "default_database_name" {
  description = "Name of the default SQL database to create."
  type        = string
  default     = "default"
}

# --- Private Endpoints ---

variable "private_endpoints" {
  description = "List of private endpoints for the Cosmos DB account."
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
  description = "Full Key Vault key URI for CMK. Required when enable_cmk is true."
  type        = string
  default     = ""
}
