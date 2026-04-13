# =============================================================================
# Storage Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/storage/storage.bicep
# =============================================================================

variable "name" {
  description = "Name of the storage account (max 24 chars, lowercase, no hyphens)."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.name))
    error_message = "Storage account name must be 3-24 lowercase alphanumeric characters."
  }
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

# --- Storage Configuration ---

variable "account_tier" {
  description = "Storage account tier."
  type        = string
  default     = "Standard"
}

variable "account_replication_type" {
  description = "Replication type (LRS, ZRS, GRS, RAGRS, GZRS, RAGZRS)."
  type        = string
  default     = "ZRS"
}

variable "account_kind" {
  description = "Storage account kind."
  type        = string
  default     = "StorageV2"
}

variable "access_tier" {
  description = "Default access tier for blobs."
  type        = string
  default     = "Hot"
}

variable "is_hns_enabled" {
  description = "Enable Hierarchical Namespace (Data Lake Gen2)."
  type        = bool
  default     = true
}

variable "min_tls_version" {
  description = "Minimum TLS version."
  type        = string
  default     = "TLS1_2"
}

variable "allow_blob_public_access" {
  description = "Allow public access to blobs."
  type        = bool
  default     = false
}

variable "shared_access_key_enabled" {
  description = "Allow shared key access."
  type        = bool
  default     = false
}

variable "infrastructure_encryption_enabled" {
  description = "Enable infrastructure (double) encryption."
  type        = bool
  default     = true
}

variable "file_system_names" {
  description = "List of ADLS Gen2 file system (container) names to create."
  type        = list(string)
  default     = []
}

# --- Lifecycle Management ---

variable "lifecycle_cool_after_days" {
  description = "Days after last modification before tiering blobs to Cool."
  type        = number
  default     = 90
}

# --- Blob Properties ---

variable "blob_soft_delete_retention_days" {
  description = "Soft-delete retention for blobs in days."
  type        = number
  default     = 30
}

variable "container_soft_delete_retention_days" {
  description = "Soft-delete retention for containers in days."
  type        = number
  default     = 30
}

variable "versioning_enabled" {
  description = "Enable blob versioning."
  type        = bool
  default     = true
}

variable "change_feed_enabled" {
  description = "Enable blob change feed."
  type        = bool
  default     = true
}

variable "change_feed_retention_in_days" {
  description = "Retention for change feed in days."
  type        = number
  default     = 30
}

# --- Private Endpoints ---

variable "private_endpoints" {
  description = "List of private endpoints to create. Each entry has subnet_id, subresource (blob/dfs/table/queue), and optional private_dns_zone_id."
  type = list(object({
    name                = string
    subnet_id           = string
    subresource         = string
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
  description = "Key Vault Key ID for CMK encryption. Required when enable_cmk is true."
  type        = string
  default     = ""
}

variable "cmk_identity_id" {
  description = "Resource ID of the user-assigned managed identity for CMK."
  type        = string
  default     = ""
}
