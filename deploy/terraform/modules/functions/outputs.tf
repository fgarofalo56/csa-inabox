# =============================================================================
# Functions Module — Outputs
# =============================================================================

output "function_app_id" {
  description = "Resource ID of the Function App."
  value       = local.function_app_id
}

output "function_app_name" {
  description = "Name of the Function App."
  value       = local.function_app_name
}

output "default_hostname" {
  description = "Default hostname of the Function App."
  value       = local.default_hostname
}

output "identity_principal_id" {
  description = "Principal ID of the system-assigned managed identity."
  value       = local.identity_principal_id
}

output "service_plan_id" {
  description = "Resource ID of the App Service Plan."
  value       = azurerm_service_plan.this.id
}
