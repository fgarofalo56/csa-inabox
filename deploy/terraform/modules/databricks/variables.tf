# =============================================================================
# Databricks Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/databricks/databricks.bicep
# =============================================================================

variable "workspace_name" {
  description = "Name of the Databricks workspace."
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

variable "sku" {
  description = "Pricing tier (standard, premium, trial)."
  type        = string
  default     = "premium"
  validation {
    condition     = contains(["standard", "premium", "trial"], var.sku)
    error_message = "Must be standard, premium, or trial."
  }
}

variable "managed_resource_group_name" {
  description = "Name of the managed resource group for Databricks. Defaults to workspace_name-managed-rg."
  type        = string
  default     = ""
}

variable "public_network_access_enabled" {
  description = "Enable public network access."
  type        = bool
  default     = false
}

variable "no_public_ip" {
  description = "Disable public IPs on cluster nodes (secure cluster connectivity)."
  type        = bool
  default     = true
}

variable "network_security_group_rules_required" {
  description = "NSG rules required (AllRules, NoAzureDatabricksRules)."
  type        = string
  default     = "NoAzureDatabricksRules"
}

# --- VNet Injection ---

variable "vnet_id" {
  description = "Resource ID of the VNet for VNet injection. Empty to skip."
  type        = string
  default     = ""
}

variable "public_subnet_name" {
  description = "Name of the public (host) subnet for Databricks."
  type        = string
  default     = "databricks-public"
}

variable "private_subnet_name" {
  description = "Name of the private (container) subnet for Databricks."
  type        = string
  default     = "databricks-private"
}

variable "public_subnet_network_security_group_association_id" {
  description = "NSG association ID for the public subnet."
  type        = string
  default     = ""
}

variable "private_subnet_network_security_group_association_id" {
  description = "NSG association ID for the private subnet."
  type        = string
  default     = ""
}

# --- Private Endpoints ---

variable "private_endpoints" {
  description = "List of private endpoints for the workspace."
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
  description = "Enable Customer-Managed Key encryption for managed services and managed disk."
  type        = bool
  default     = false
}

variable "cmk_key_vault_key_id" {
  description = "Key Vault Key ID for CMK encryption. Required when enable_cmk is true."
  type        = string
  default     = ""
}

variable "cmk_key_vault_id" {
  description = "Resource ID of the Key Vault containing the CMK key. Required in azurerm v4 when enable_cmk is true."
  type        = string
  default     = ""
}
