# =============================================================================
# Monitoring Module — Outputs
# =============================================================================

output "log_analytics_workspace_id" {
  description = "Resource ID of the Log Analytics workspace."
  value       = azurerm_log_analytics_workspace.this.id
}

output "log_analytics_workspace_name" {
  description = "Name of the Log Analytics workspace."
  value       = azurerm_log_analytics_workspace.this.name
}

output "log_analytics_primary_shared_key" {
  description = "Primary shared key for the workspace."
  value       = azurerm_log_analytics_workspace.this.primary_shared_key
  sensitive   = true
}

output "app_insights_id" {
  description = "Resource ID of Application Insights."
  value       = var.deploy_app_insights ? azurerm_application_insights.this[0].id : ""
}

output "app_insights_name" {
  description = "Name of Application Insights."
  value       = var.deploy_app_insights ? azurerm_application_insights.this[0].name : ""
}

output "app_insights_instrumentation_key" {
  description = "Application Insights instrumentation key."
  value       = var.deploy_app_insights ? azurerm_application_insights.this[0].instrumentation_key : ""
  sensitive   = true
}

output "app_insights_connection_string" {
  description = "Application Insights connection string."
  value       = var.deploy_app_insights ? azurerm_application_insights.this[0].connection_string : ""
  sensitive   = true
}
