# =============================================================================
# Key Vault Module — Main Resources
# Mirrors: deploy/bicep/DMLZ/modules/KeyVault/keyvault.bicep
# Features: RBAC authorization, soft-delete, purge protection,
#           network ACLs, private endpoints, diagnostics, resource locks
# =============================================================================

data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
  tenant_id           = data.azurerm_client_config.current.tenant_id

  sku_name                        = var.sku_name
  enable_rbac_authorization       = var.enable_rbac_authorization
  soft_delete_retention_days      = var.soft_delete_retention_days
  purge_protection_enabled        = var.purge_protection_enabled
  enabled_for_deployment          = var.enabled_for_deployment
  enabled_for_disk_encryption     = var.enabled_for_disk_encryption
  enabled_for_template_deployment = var.enabled_for_template_deployment
  public_network_access_enabled   = var.public_network_access_enabled

  network_acls {
    bypass         = var.network_acl_bypass
    default_action = var.network_acl_default_action
    ip_rules       = []
  }
}

# --- Private Endpoints ---

resource "azurerm_private_endpoint" "this" {
  for_each = { for pe in var.private_endpoints : pe.name => pe }

  name                = each.value.name
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = each.value.subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "${each.value.name}-connection"
    private_connection_resource_id = azurerm_key_vault.this.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  dynamic "private_dns_zone_group" {
    for_each = each.value.private_dns_zone_id != "" ? [1] : []
    content {
      name                 = "default"
      private_dns_zone_ids = [each.value.private_dns_zone_id]
    }
  }
}

# --- Diagnostic Settings ---

resource "azurerm_monitor_diagnostic_setting" "this" {
  count = var.log_analytics_workspace_id != "" ? 1 : 0

  name                       = "${var.name}-diagnostics"
  target_resource_id         = azurerm_key_vault.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category_group = "allLogs"
  }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}

# --- Resource Lock ---

resource "azurerm_management_lock" "this" {
  count = var.enable_resource_lock ? 1 : 0

  name       = "${var.name}-no-delete"
  scope      = azurerm_key_vault.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Key Vault. Remove lock before deleting."
}
