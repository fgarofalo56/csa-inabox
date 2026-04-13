# =============================================================================
# Data Factory Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/datafactory/datafactory.bicep
# Features: Managed VNet, auto-resolve IR, Key Vault linked service,
#           private endpoints (dataFactory, portal), diagnostics,
#           resource locks, CMK encryption
# =============================================================================

resource "azurerm_data_factory" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  managed_virtual_network_enabled = var.managed_virtual_network_enabled
  public_network_enabled          = var.public_network_enabled

  identity {
    type         = var.enable_cmk ? "SystemAssigned, UserAssigned" : "SystemAssigned"
    identity_ids = var.enable_cmk ? [var.cmk_identity_id] : []
  }

  customer_managed_key_id          = var.enable_cmk ? var.cmk_key_vault_key_id : null
  customer_managed_key_identity_id = var.enable_cmk ? var.cmk_identity_id : null
}

# --- AutoResolve Integration Runtime ---

resource "azurerm_data_factory_integration_runtime_azure" "autoresolve" {
  count = var.managed_virtual_network_enabled ? 1 : 0

  name                    = "AutoResolveIntegrationRuntime"
  data_factory_id         = azurerm_data_factory.this.id
  location                = "AutoResolve"
  virtual_network_enabled = true
  time_to_live_min        = 10
  compute_type            = "General"
  core_count              = 8
}

# --- Key Vault Linked Service ---

resource "azurerm_data_factory_linked_service_key_vault" "this" {
  count = var.key_vault_id != "" ? 1 : 0

  name            = "ls_KeyVault"
  data_factory_id = azurerm_data_factory.this.id
  key_vault_id    = var.key_vault_id
}

# --- Private Endpoints (dataFactory) ---

resource "azurerm_private_endpoint" "data_factory" {
  for_each = { for pe in var.private_endpoints_data_factory : pe.name => pe }

  name                = each.value.name
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = each.value.subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "${each.value.name}-connection"
    private_connection_resource_id = azurerm_data_factory.this.id
    subresource_names              = ["dataFactory"]
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

# --- Private Endpoints (portal) ---

resource "azurerm_private_endpoint" "portal" {
  for_each = { for pe in var.private_endpoints_portal : pe.name => pe }

  name                = each.value.name
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = each.value.subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "${each.value.name}-connection"
    private_connection_resource_id = azurerm_data_factory.this.id
    subresource_names              = ["portal"]
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
  target_resource_id         = azurerm_data_factory.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log { category = "ActivityRuns" }
  enabled_log { category = "PipelineRuns" }
  enabled_log { category = "TriggerRuns" }
  enabled_log { category = "SSISIntegrationRuntimeLogs" }
  enabled_log { category = "SSISPackageEventMessageContext" }
  enabled_log { category = "SSISPackageEventMessages" }
  enabled_log { category = "SSISPackageExecutableStatistics" }
  enabled_log { category = "SSISPackageExecutionComponentPhases" }
  enabled_log { category = "SSISPackageExecutionDataStatistics" }
  enabled_log { category = "SandboxActivityRuns" }
  enabled_log { category = "SandboxPipelineRuns" }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}

# --- Resource Lock ---

resource "azurerm_management_lock" "this" {
  count = var.enable_resource_lock ? 1 : 0

  name       = "${var.name}-no-delete"
  scope      = azurerm_data_factory.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Data Factory. Remove lock before deleting."
}
