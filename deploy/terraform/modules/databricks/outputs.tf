# =============================================================================
# Databricks Module — Outputs
# =============================================================================

output "workspace_id" {
  description = "Resource ID of the Databricks workspace."
  value       = azurerm_databricks_workspace.this.id
}

output "workspace_url" {
  description = "URL of the Databricks workspace."
  value       = azurerm_databricks_workspace.this.workspace_url
}

output "managed_resource_group_id" {
  description = "Resource ID of the managed resource group."
  value       = azurerm_databricks_workspace.this.managed_resource_group_id
}

output "identity_principal_id" {
  description = "Principal ID of the managed identity (storage identity)."
  value       = azurerm_databricks_workspace.this.storage_account_identity[0].principal_id
}
