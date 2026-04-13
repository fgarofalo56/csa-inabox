# =============================================================================
# Cosmos DB Module — Outputs
# =============================================================================

output "account_id" {
  description = "Resource ID of the Cosmos DB account."
  value       = azurerm_cosmosdb_account.this.id
}

output "account_name" {
  description = "Name of the Cosmos DB account."
  value       = azurerm_cosmosdb_account.this.name
}

output "endpoint" {
  description = "Endpoint URL of the Cosmos DB account."
  value       = azurerm_cosmosdb_account.this.endpoint
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = azurerm_cosmosdb_account.this.identity[0].principal_id
}

output "default_database_id" {
  description = "Resource ID of the default SQL database."
  value       = var.default_database_name != "" ? azurerm_cosmosdb_sql_database.default[0].id : ""
}
