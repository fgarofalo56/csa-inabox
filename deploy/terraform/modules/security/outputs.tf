# =============================================================================
# Security Module — Outputs
# =============================================================================

output "cmk_identity_id" {
  description = "Resource ID of the CMK user-assigned managed identity."
  value       = var.deploy_cmk_identity ? azurerm_user_assigned_identity.cmk[0].id : ""
}

output "cmk_identity_principal_id" {
  description = "Principal ID of the CMK identity."
  value       = var.deploy_cmk_identity ? azurerm_user_assigned_identity.cmk[0].principal_id : ""
}

output "cmk_identity_client_id" {
  description = "Client ID of the CMK identity."
  value       = var.deploy_cmk_identity ? azurerm_user_assigned_identity.cmk[0].client_id : ""
}

output "cmk_key_id" {
  description = "Key Vault Key ID (versionless)."
  value       = var.deploy_cmk_key ? azurerm_key_vault_key.cmk[0].id : ""
}

output "cmk_key_versionless_id" {
  description = "Key Vault Key versionless ID."
  value       = var.deploy_cmk_key ? azurerm_key_vault_key.cmk[0].versionless_id : ""
}

output "cmk_key_vault_uri" {
  description = "Key Vault URI derived from key ID."
  value       = var.deploy_cmk_key ? trimsuffix(azurerm_key_vault_key.cmk[0].id, "/keys/${var.cmk_key_name}/${azurerm_key_vault_key.cmk[0].version}") : ""
}
