# =============================================================================
# Stream Analytics Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/streamanalytics/streamanalytics.bicep
# =============================================================================

variable "job_name" {
  description = "Name of the Stream Analytics job."
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

# --- Job Configuration ---

variable "sku_name" {
  description = "SKU for the Stream Analytics job."
  type        = string
  default     = "Standard"
}

variable "streaming_units" {
  description = "Number of streaming units."
  type        = number
  default     = 3
}

variable "compatibility_level" {
  description = "Compatibility level."
  type        = string
  default     = "1.2"
}

variable "content_storage_policy" {
  description = "Content storage policy (SystemAccount or JobStorageAccount)."
  type        = string
  default     = "SystemAccount"
}

variable "transformation_query" {
  description = "Default transformation query."
  type        = string
  default     = "SELECT * INTO [output] FROM [input]"
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
