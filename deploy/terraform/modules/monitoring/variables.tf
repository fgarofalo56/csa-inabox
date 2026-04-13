# =============================================================================
# Monitoring Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/monitoring/appinsights.bicep
#          + Log Analytics workspace
# =============================================================================

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

# --- Log Analytics ---

variable "log_analytics_workspace_name" {
  description = "Name of the Log Analytics workspace."
  type        = string
}

variable "log_analytics_sku" {
  description = "SKU for the Log Analytics workspace."
  type        = string
  default     = "PerGB2018"
}

variable "log_analytics_retention_in_days" {
  description = "Data retention in days."
  type        = number
  default     = 90
}

variable "log_analytics_daily_quota_gb" {
  description = "Daily ingestion quota in GB. -1 for unlimited."
  type        = number
  default     = -1
}

# --- Application Insights ---

variable "deploy_app_insights" {
  description = "Deploy Application Insights."
  type        = bool
  default     = true
}

variable "app_insights_name" {
  description = "Name of the Application Insights resource."
  type        = string
  default     = ""
}

variable "app_insights_type" {
  description = "Application type (web, ios, java, etc.)."
  type        = string
  default     = "web"
}

variable "app_insights_disable_local_auth" {
  description = "Disable local (API key) authentication."
  type        = bool
  default     = true
}

# --- Solutions ---

variable "solutions" {
  description = "List of Log Analytics solutions to deploy."
  type = list(object({
    solution_name = string
    publisher     = optional(string, "Microsoft")
    product       = string
  }))
  default = []
}

# --- Resource Lock ---

variable "enable_resource_lock" {
  description = "Attach a CanNotDelete resource lock to Log Analytics."
  type        = bool
  default     = true
}
