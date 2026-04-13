# =============================================================================
# Machine Learning Module — Outputs
# =============================================================================

output "workspace_id" {
  description = "Resource ID of the Machine Learning workspace."
  value       = azurerm_machine_learning_workspace.this.id
}

output "workspace_name" {
  description = "Name of the workspace."
  value       = azurerm_machine_learning_workspace.this.name
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = azurerm_machine_learning_workspace.this.identity[0].principal_id
}

output "identity_tenant_id" {
  description = "Tenant ID of the managed identity."
  value       = azurerm_machine_learning_workspace.this.identity[0].tenant_id
}

output "discovery_url" {
  description = "Discovery URL for the workspace."
  value       = azurerm_machine_learning_workspace.this.discovery_url
}
