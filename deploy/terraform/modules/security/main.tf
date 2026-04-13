# =============================================================================
# Security Module — Main Resources
# Mirrors: deploy/bicep/shared/modules/security/cmkIdentity.bicep
# Features: User-assigned managed identity for CMK, Key Vault key,
#           RBAC role assignment (Key Vault Crypto User)
# =============================================================================

# Key Vault Crypto User role definition ID
locals {
  key_vault_crypto_user_role_id = "12338af0-0e69-4776-bea7-57ae8d297424"
}

# --- User-Assigned Managed Identity ---

resource "azurerm_user_assigned_identity" "cmk" {
  count = var.deploy_cmk_identity ? 1 : 0

  name                = var.cmk_identity_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

# --- Key Vault Key ---

resource "azurerm_key_vault_key" "cmk" {
  count = var.deploy_cmk_key ? 1 : 0

  name         = var.cmk_key_name
  key_vault_id = var.key_vault_id
  key_type     = var.cmk_key_type
  key_size     = var.cmk_key_size
  key_opts     = var.cmk_key_opts

  rotation_policy {
    automatic {
      time_before_expiry = "P30D"
    }
    expire_after         = "P365D"
    notify_before_expiry = "P30D"
  }
}

# --- RBAC: Key Vault Crypto User ---

resource "azurerm_role_assignment" "crypto_user" {
  count = var.deploy_cmk_identity && var.assign_crypto_user_role && var.key_vault_id != "" ? 1 : 0

  scope                = var.key_vault_id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = azurerm_user_assigned_identity.cmk[0].principal_id
  principal_type       = "ServicePrincipal"
  description          = "CSA-in-a-Box CMK identity - Key Vault Crypto User for encryption key operations"
}
