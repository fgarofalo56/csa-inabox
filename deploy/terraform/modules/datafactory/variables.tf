# =============================================================================
# Data Factory Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/datafactory/datafactory.bicep
# =============================================================================

variable "name" {
  description = "Name of the Data Factory."
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

# --- Factory Configuration ---

variable "managed_virtual_network_enabled" {
  description = "Enable managed virtual network."
  type        = bool
  default     = true
}

variable "public_network_enabled" {
  description = "Enable public network access."
  type        = bool
  default     = false
}

# --- Key Vault Linked Service ---

variable "key_vault_id" {
  description = "Resource ID of Key Vault for linked service. Empty to skip."
  type        = string
  default     = ""
}

variable "key_vault_uri" {
  description = "URI of Key Vault for linked service. Auto-derived if key_vault_id provided."
  type        = string
  default     = ""
}

# --- Private Endpoints ---

variable "private_endpoints_data_factory" {
  description = "Private endpoints for dataFactory subresource."
  type = list(object({
    name                = string
    subnet_id           = string
    private_dns_zone_id = optional(string, "")
  }))
  default = []
}

variable "private_endpoints_portal" {
  description = "Private endpoints for portal subresource."
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

variable "cmk_identity_id" {
  description = "Resource ID of the user-assigned managed identity for CMK."
  type        = string
  default     = ""
}
