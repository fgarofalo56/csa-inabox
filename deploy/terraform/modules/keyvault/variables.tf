# =============================================================================
# Key Vault Module — Variables
# Mirrors: deploy/bicep/DMLZ/modules/KeyVault/keyvault.bicep
# =============================================================================

variable "name" {
  description = "Name of the Key Vault."
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

# --- Key Vault Configuration ---

variable "sku_name" {
  description = "SKU name (standard or premium)."
  type        = string
  default     = "standard"
}

variable "enable_rbac_authorization" {
  description = "Use RBAC authorization instead of access policies."
  type        = bool
  default     = true
}

variable "soft_delete_retention_days" {
  description = "Soft-delete retention in days."
  type        = number
  default     = 90
}

variable "purge_protection_enabled" {
  description = "Enable purge protection."
  type        = bool
  default     = true
}

variable "enabled_for_deployment" {
  description = "Allow VMs to retrieve certificates."
  type        = bool
  default     = false
}

variable "enabled_for_disk_encryption" {
  description = "Allow disk encryption to retrieve secrets."
  type        = bool
  default     = false
}

variable "enabled_for_template_deployment" {
  description = "Allow ARM to retrieve secrets."
  type        = bool
  default     = false
}

variable "public_network_access_enabled" {
  description = "Allow public network access."
  type        = bool
  default     = false
}

# --- Network ACLs ---

variable "network_acl_bypass" {
  description = "Network ACL bypass (AzureServices or None)."
  type        = string
  default     = "AzureServices"
}

variable "network_acl_default_action" {
  description = "Default network ACL action (Allow or Deny)."
  type        = string
  default     = "Deny"
}

# --- Private Endpoints ---

variable "private_endpoints" {
  description = "List of private endpoints for the Key Vault."
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
