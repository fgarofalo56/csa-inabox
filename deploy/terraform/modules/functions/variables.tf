# =============================================================================
# Functions Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/functions/functions.bicep
# =============================================================================

variable "function_app_name" {
  description = "Name of the Function App."
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

# --- Function App Configuration ---

variable "os_type" {
  description = "Operating system type (Linux, Windows)."
  type        = string
  default     = "Linux"
}

variable "runtime" {
  description = "Function runtime (python, node, dotnet, java)."
  type        = string
  default     = "python"
}

variable "runtime_version" {
  description = "Runtime version."
  type        = string
  default     = "3.11"
}

variable "plan_sku" {
  description = "App Service Plan SKU (Y1 for consumption, EP1-EP3 for premium)."
  type        = string
  default     = "EP1"
}

# --- Dependencies ---

variable "storage_account_name" {
  description = "Name of the storage account for the Function App."
  type        = string
}

variable "storage_account_access_key" {
  description = "Access key for the storage account. Leave empty to use managed identity."
  type        = string
  sensitive   = true
  default     = ""
}

variable "storage_uses_managed_identity" {
  description = "Use managed identity for storage account access instead of access keys."
  type        = bool
  default     = true
}

variable "application_insights_connection_string" {
  description = "Application Insights connection string."
  type        = string
  default     = ""
}

variable "application_insights_key" {
  description = "Application Insights instrumentation key."
  type        = string
  default     = ""
}

# --- Networking ---

variable "enable_vnet_integration" {
  description = "Enable VNet integration."
  type        = bool
  default     = false
}

variable "vnet_integration_subnet_id" {
  description = "Subnet ID for VNet integration."
  type        = string
  default     = ""
}

# --- Private Endpoints ---

variable "private_endpoints" {
  description = "List of private endpoints for the Function App."
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
