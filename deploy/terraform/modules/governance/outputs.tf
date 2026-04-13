# =============================================================================
# Governance Module — Outputs
# =============================================================================

output "purview_account_id" {
  description = "Resource ID of the Purview account."
  value       = azurerm_purview_account.this.id
}

output "purview_account_name" {
  description = "Name of the Purview account."
  value       = azurerm_purview_account.this.name
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = azurerm_purview_account.this.identity[0].principal_id
}

output "managed_resource_group_name" {
  description = "Name of the managed resource group."
  value       = local.managed_rg_name
}

output "atlas_kafka_endpoint_primary_connection_string" {
  description = "Atlas Kafka endpoint connection string."
  value       = azurerm_purview_account.this.atlas_kafka_endpoint_primary_connection_string
  sensitive   = true
}
