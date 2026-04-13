# =============================================================================
# Storage Module — Outputs
# =============================================================================

output "storage_account_id" {
  description = "Resource ID of the storage account."
  value       = azurerm_storage_account.this.id
}

output "storage_account_name" {
  description = "Name of the storage account."
  value       = azurerm_storage_account.this.name
}

output "primary_blob_endpoint" {
  description = "Primary blob endpoint URL."
  value       = azurerm_storage_account.this.primary_blob_endpoint
}

output "primary_dfs_endpoint" {
  description = "Primary DFS endpoint URL."
  value       = azurerm_storage_account.this.primary_dfs_endpoint
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = azurerm_storage_account.this.identity[0].principal_id
}

output "identity_tenant_id" {
  description = "Tenant ID of the system-assigned managed identity."
  value       = azurerm_storage_account.this.identity[0].tenant_id
}

output "file_system_ids" {
  description = "Map of file system names to their resource IDs."
  value       = { for k, v in azurerm_storage_data_lake_gen2_filesystem.this : k => v.id }
}
