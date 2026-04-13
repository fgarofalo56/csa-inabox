# =============================================================================
# Key Vault Module — Outputs
# =============================================================================

output "key_vault_id" {
  description = "Resource ID of the Key Vault."
  value       = azurerm_key_vault.this.id
}

output "key_vault_name" {
  description = "Name of the Key Vault."
  value       = azurerm_key_vault.this.name
}

output "key_vault_uri" {
  description = "URI of the Key Vault."
  value       = azurerm_key_vault.this.vault_uri
}

output "tenant_id" {
  description = "Tenant ID of the Key Vault."
  value       = azurerm_key_vault.this.tenant_id
}
