# =============================================================================
# Data Factory Module — Outputs
# =============================================================================

output "factory_id" {
  description = "Resource ID of the Data Factory."
  value       = azurerm_data_factory.this.id
}

output "factory_name" {
  description = "Name of the Data Factory."
  value       = azurerm_data_factory.this.name
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = azurerm_data_factory.this.identity[0].principal_id
}

output "identity_tenant_id" {
  description = "Tenant ID of the managed identity."
  value       = azurerm_data_factory.this.identity[0].tenant_id
}
