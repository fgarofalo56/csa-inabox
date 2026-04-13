# =============================================================================
# DMLZ (Data Management Landing Zone) — Outputs
# Mirrors outputs from: deploy/bicep/DMLZ/main.bicep
# =============================================================================

# --- Networking ---
output "vnet_ids" {
  description = "Map of VNet names to IDs."
  value       = var.deploy_networking ? module.networking[0].vnet_ids : {}
}

output "subnet_ids" {
  description = "Map of subnet keys to IDs."
  value       = var.deploy_networking ? module.networking[0].subnet_ids : {}
}

output "private_dns_zone_ids" {
  description = "Map of private DNS zone names to IDs."
  value       = var.deploy_networking ? module.networking[0].private_dns_zone_ids : {}
}

# --- Monitoring ---
output "log_analytics_workspace_id" {
  description = "Resource ID of the Log Analytics workspace."
  value       = var.deploy_monitoring ? module.monitoring[0].log_analytics_workspace_id : ""
}

# --- Key Vault ---
output "key_vault_id" {
  description = "Resource ID of the Key Vault."
  value       = var.deploy_keyvault ? module.keyvault[0].key_vault_id : ""
}

output "key_vault_uri" {
  description = "URI of the Key Vault."
  value       = var.deploy_keyvault ? module.keyvault[0].key_vault_uri : ""
}

# --- Security ---
output "cmk_identity_id" {
  description = "Resource ID of the CMK user-assigned managed identity."
  value       = var.deploy_security ? module.security[0].cmk_identity_id : ""
}

output "cmk_key_id" {
  description = "Key Vault Key ID for CMK encryption."
  value       = var.deploy_security ? module.security[0].cmk_key_id : ""
}

# --- Governance ---
output "purview_account_id" {
  description = "Resource ID of the Purview account."
  value       = var.deploy_governance ? module.governance[0].purview_account_id : ""
}

output "governance_resource_group_name" {
  description = "Name of the governance resource group."
  value       = var.deploy_governance ? azurerm_resource_group.governance[0].name : ""
}

# --- Databricks ---
output "databricks_governance_workspace_id" {
  description = "Resource ID of the governance Databricks workspace."
  value       = var.deploy_databricks ? module.databricks[0].workspace_id : ""
}

output "databricks_governance_workspace_url" {
  description = "URL of the governance Databricks workspace."
  value       = var.deploy_databricks ? module.databricks[0].workspace_url : ""
}
