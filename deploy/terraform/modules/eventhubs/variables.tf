# =============================================================================
# Event Hubs Module — Variables
# Mirrors: deploy/bicep/DLZ/modules/eventhubs/eventhubs.bicep
# =============================================================================

variable "namespace_name" {
  description = "Name of the Event Hubs namespace."
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

# --- Namespace Configuration ---

variable "sku" {
  description = "SKU for the Event Hubs namespace (Basic, Standard, Premium)."
  type        = string
  default     = "Standard"
  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.sku)
    error_message = "Must be Basic, Standard, or Premium."
  }
}

variable "capacity" {
  description = "Throughput units (1-40 for Standard)."
  type        = number
  default     = 1
}

variable "auto_inflate_enabled" {
  description = "Enable auto-inflate for Standard SKU."
  type        = bool
  default     = true
}

variable "maximum_throughput_units" {
  description = "Maximum throughput units for auto-inflate (0-40)."
  type        = number
  default     = 10
}

variable "kafka_enabled" {
  description = "Enable Kafka protocol support."
  type        = bool
  default     = true
}

variable "local_authentication_enabled" {
  description = "Enable local (SAS key) authentication."
  type        = bool
  default     = false
}

variable "minimum_tls_version" {
  description = "Minimum TLS version."
  type        = string
  default     = "1.2"
}

variable "public_network_access_enabled" {
  description = "Enable public network access."
  type        = bool
  default     = false
}

# --- Event Hubs ---

variable "event_hubs" {
  description = "List of event hubs to create."
  type = list(object({
    name                   = string
    partition_count        = optional(number, 4)
    message_retention_days = optional(number, 7)
    consumer_groups        = optional(list(string), ["analytics"])
  }))
  default = []
}

# --- Private Endpoints ---

variable "private_endpoints" {
  description = "List of private endpoints for the namespace."
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
