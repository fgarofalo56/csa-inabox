# =============================================================================
# Data Explorer (Kusto) Module — Outputs
# =============================================================================

output "cluster_id" {
  description = "Resource ID of the Kusto cluster."
  value       = azurerm_kusto_cluster.this.id
}

output "cluster_name" {
  description = "Name of the Kusto cluster."
  value       = azurerm_kusto_cluster.this.name
}

output "cluster_uri" {
  description = "URI of the Kusto cluster."
  value       = azurerm_kusto_cluster.this.uri
}

output "data_ingestion_uri" {
  description = "Data ingestion URI."
  value       = azurerm_kusto_cluster.this.data_ingestion_uri
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = azurerm_kusto_cluster.this.identity[0].principal_id
}

output "database_ids" {
  description = "Map of database names to their resource IDs."
  value       = { for k, v in azurerm_kusto_database.this : k => v.id }
}
