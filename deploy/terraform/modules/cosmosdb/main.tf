# =============================================================================
# Cosmos DB Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/cosmos/cosmosdb.bicep
# Features: SQL API, multi-region, automatic failover, continuous backup,
#           private endpoints, diagnostics, resource locks, CMK
# =============================================================================

resource "azurerm_cosmosdb_account" "this" {
  name                = var.account_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  kind                              = var.kind
  offer_type                        = "Standard"
  automatic_failover_enabled        = var.enable_automatic_failover
  multiple_write_locations_enabled   = var.enable_multiple_write_locations
  analytical_storage_enabled        = var.enable_analytical_storage
  free_tier_enabled                 = var.enable_free_tier
  public_network_access_enabled     = var.public_network_access_enabled
  local_authentication_disabled     = var.local_authentication_disabled
  key_vault_key_id                  = var.enable_cmk ? var.cmk_key_vault_key_id : null
  access_key_metadata_writes_enabled = !var.disable_key_based_metadata_write_access

  identity {
    type = "SystemAssigned"
  }

  consistency_policy {
    consistency_level       = var.consistency_level
    max_interval_in_seconds = 5
    max_staleness_prefix    = 100
  }

  # Primary location
  geo_location {
    location          = var.location
    failover_priority = 0
    zone_redundant    = var.zone_redundancy_enabled
  }

  # Optional secondary location
  dynamic "geo_location" {
    for_each = var.secondary_location != "" ? [var.secondary_location] : []
    content {
      location          = geo_location.value
      failover_priority = 1
      zone_redundant    = var.zone_redundancy_enabled
    }
  }

  # Backup policy
  dynamic "backup" {
    for_each = var.backup_type == "Continuous" ? [1] : []
    content {
      type = "Continuous"
      tier = var.continuous_backup_tier
    }
  }

  dynamic "backup" {
    for_each = var.backup_type == "Periodic" ? [1] : []
    content {
      type                = "Periodic"
      interval_in_minutes = var.backup_interval_in_minutes
      retention_in_hours  = var.backup_retention_in_hours
    }
  }
}

# --- Default SQL Database ---

resource "azurerm_cosmosdb_sql_database" "default" {
  count = var.default_database_name != "" ? 1 : 0

  name                = var.default_database_name
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
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
    private_connection_resource_id = azurerm_cosmosdb_account.this.id
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

# --- Diagnostic Settings ---

resource "azurerm_monitor_diagnostic_setting" "this" {
  count = var.log_analytics_workspace_id != "" ? 1 : 0

  name                       = "${var.account_name}-diagnostics"
  target_resource_id         = azurerm_cosmosdb_account.this.id
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

  name       = "${var.account_name}-no-delete"
  scope      = azurerm_cosmosdb_account.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Cosmos DB account. Remove lock before deleting."
}
