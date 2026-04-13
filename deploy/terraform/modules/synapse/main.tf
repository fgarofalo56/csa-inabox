# =============================================================================
# Synapse Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/synapse/synapse.bicep
# Features: Managed VNet, data exfiltration protection, SQL admin,
#           SQL pool, private endpoints (SQL, SqlOnDemand, Dev),
#           diagnostics, resource locks, CMK encryption
# =============================================================================

resource "azurerm_synapse_workspace" "this" {
  name                = var.workspace_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  storage_data_lake_gen2_filesystem_id = var.storage_data_lake_gen2_filesystem_id
  sql_administrator_login              = var.sql_administrator_login
  sql_administrator_login_password     = var.sql_administrator_login_password

  managed_virtual_network_enabled      = var.managed_virtual_network_enabled
  data_exfiltration_protection_enabled = var.data_exfiltration_protection_enabled
  public_network_access_enabled        = var.public_network_access_enabled
  managed_resource_group_name          = var.managed_resource_group_name != "" ? var.managed_resource_group_name : var.workspace_name
  purview_id                           = var.purview_id != "" ? var.purview_id : null
  compute_subnet_id                    = var.compute_subnet_id != "" ? var.compute_subnet_id : null

  identity {
    type = "SystemAssigned"
  }

  dynamic "customer_managed_key" {
    for_each = var.enable_cmk ? [1] : []
    content {
      key_name         = var.cmk_key_name
      key_versionless_id = var.cmk_key_vault_url
    }
  }
}

# --- SQL Pool ---

resource "azurerm_synapse_sql_pool" "this" {
  count = var.deploy_sql_pool ? 1 : 0

  name                 = var.sql_pool_name
  synapse_workspace_id = azurerm_synapse_workspace.this.id
  sku_name             = var.sql_pool_sku
  create_mode          = "Default"
  collation            = "SQL_Latin1_General_CP1_CI_AS"
  geo_backup_policy_enabled = true
  tags                 = var.tags
}

# --- Managed Identity SQL Control ---

resource "azurerm_synapse_workspace_sql_aad_admin" "this" {
  count = var.aad_admin_login != "" && var.aad_admin_object_id != "" ? 1 : 0

  synapse_workspace_id = azurerm_synapse_workspace.this.id
  login                = var.aad_admin_login
  object_id            = var.aad_admin_object_id
  tenant_id            = azurerm_synapse_workspace.this.identity[0].tenant_id
}

# --- Private Endpoints (SQL) ---

resource "azurerm_private_endpoint" "sql" {
  for_each = { for pe in var.private_endpoints_sql : pe.name => pe }

  name                = each.value.name
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = each.value.subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "${each.value.name}-connection"
    private_connection_resource_id = azurerm_synapse_workspace.this.id
    subresource_names              = ["Sql"]
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

# --- Private Endpoints (SqlOnDemand) ---

resource "azurerm_private_endpoint" "sql_ondemand" {
  for_each = { for pe in var.private_endpoints_sql_ondemand : pe.name => pe }

  name                = each.value.name
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = each.value.subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "${each.value.name}-connection"
    private_connection_resource_id = azurerm_synapse_workspace.this.id
    subresource_names              = ["SqlOnDemand"]
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

# --- Private Endpoints (Dev) ---

resource "azurerm_private_endpoint" "dev" {
  for_each = { for pe in var.private_endpoints_dev : pe.name => pe }

  name                = each.value.name
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = each.value.subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "${each.value.name}-connection"
    private_connection_resource_id = azurerm_synapse_workspace.this.id
    subresource_names              = ["Dev"]
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

  name                       = "${var.workspace_name}-diagnostics"
  target_resource_id         = azurerm_synapse_workspace.this.id
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

  name       = "${var.workspace_name}-no-delete"
  scope      = azurerm_synapse_workspace.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Synapse workspace. Remove lock before deleting."
}
