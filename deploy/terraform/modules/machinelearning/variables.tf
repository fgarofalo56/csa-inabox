# =============================================================================
# Machine Learning Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/machinelearning/machinelearning.bicep
# =============================================================================

variable "workspace_name" {
  description = "Name of the Machine Learning workspace."
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

# --- Dependencies ---

variable "storage_account_id" {
  description = "Resource ID of the associated storage account."
  type        = string
}

variable "key_vault_id" {
  description = "Resource ID of the associated Key Vault."
  type        = string
}

variable "application_insights_id" {
  description = "Resource ID of the associated Application Insights."
  type        = string
  default     = ""
}

variable "container_registry_id" {
  description = "Resource ID of the associated Container Registry."
  type        = string
  default     = ""
}

# --- Workspace Configuration ---

variable "public_network_access_enabled" {
  description = "Enable public network access."
  type        = bool
  default     = false
}

variable "managed_network_isolation_mode" {
  description = "Managed network isolation mode (Disabled, AllowInternetOutbound, AllowOnlyApprovedOutbound)."
  type        = string
  default     = "AllowOnlyApprovedOutbound"
}

variable "sku_name" {
  description = "SKU for the workspace."
  type        = string
  default     = "Basic"
}

# --- Compute Instance (optional) ---

variable "deploy_compute_instance" {
  description = "Deploy a default compute instance."
  type        = bool
  default     = false
}

variable "compute_instance_name" {
  description = "Name of the compute instance."
  type        = string
  default     = "default-ci"
}

variable "compute_instance_vm_size" {
  description = "VM size for the compute instance."
  type        = string
  default     = "Standard_DS3_v2"
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
  description = "Enable Customer-Managed Key encryption."
  type        = bool
  default     = false
}

variable "cmk_key_vault_id" {
  description = "Resource ID of the Key Vault holding the CMK key."
  type        = string
  default     = ""
}

variable "cmk_key_vault_key_id" {
  description = "Key Vault Key ID (versionless) for CMK encryption."
  type        = string
  default     = ""
}

variable "cmk_identity_id" {
  description = "Resource ID of the user-assigned managed identity for CMK."
  type        = string
  default     = ""
}
