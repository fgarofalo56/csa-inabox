# =============================================================================
# Event Hubs Module — Outputs
# =============================================================================

output "namespace_id" {
  description = "Resource ID of the Event Hubs namespace."
  value       = azurerm_eventhub_namespace.this.id
}

output "namespace_name" {
  description = "Name of the Event Hubs namespace."
  value       = azurerm_eventhub_namespace.this.name
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = azurerm_eventhub_namespace.this.identity[0].principal_id
}

output "eventhub_ids" {
  description = "Map of event hub names to their resource IDs."
  value       = { for k, v in azurerm_eventhub.this : k => v.id }
}
