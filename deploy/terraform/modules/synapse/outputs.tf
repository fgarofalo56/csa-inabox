# =============================================================================
# Synapse Module — Outputs
# =============================================================================

output "workspace_id" {
  description = "Resource ID of the Synapse workspace."
  value       = azurerm_synapse_workspace.this.id
}

output "workspace_name" {
  description = "Name of the Synapse workspace."
  value       = azurerm_synapse_workspace.this.name
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = azurerm_synapse_workspace.this.identity[0].principal_id
}

output "identity_tenant_id" {
  description = "Tenant ID of the managed identity."
  value       = azurerm_synapse_workspace.this.identity[0].tenant_id
}

output "connectivity_endpoints" {
  description = "Map of connectivity endpoints."
  value       = azurerm_synapse_workspace.this.connectivity_endpoints
}
