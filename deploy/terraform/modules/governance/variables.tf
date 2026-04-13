# =============================================================================
# Governance Module — Variables
# Mirrors: deploy/bicep/DMLZ/modules/Purview/purview.bicep
# =============================================================================

variable "purview_account_name" {
  description = "Name of the Purview account."
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

# --- Purview Configuration ---

variable "public_network_access_enabled" {
  description = "Enable public network access."
  type        = bool
  default     = false
}

variable "managed_resource_group_name" {
  description = "Name of the managed resource group for Purview."
  type        = string
  default     = ""
}

# --- Kafka Configuration ---

variable "configure_kafka" {
  description = "Deploy Event Hubs for Purview Kafka integration."
  type        = bool
  default     = false
}

variable "kafka_namespace_name" {
  description = "Name of the Event Hub namespace for Kafka."
  type        = string
  default     = ""
}

# --- Private Endpoints ---

variable "private_endpoints" {
  description = "Private endpoints for the Purview account."
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
