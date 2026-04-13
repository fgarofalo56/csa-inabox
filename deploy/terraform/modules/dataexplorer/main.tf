# =============================================================================
# Data Explorer (Kusto) Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/dataexplorer/dataexplorer.bicep
# Features: Streaming ingestion, auto-stop, double encryption,
#           databases, private endpoints, diagnostics, resource locks, CMK
# =============================================================================

resource "azurerm_kusto_cluster" "this" {
  name                = var.cluster_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  sku {
    name     = var.sku_name
    capacity = var.sku_capacity
  }

  identity {
    type         = var.enable_cmk ? "SystemAssigned, UserAssigned" : "SystemAssigned"
    identity_ids = var.enable_cmk ? [var.cmk_identity_id] : []
  }

  streaming_ingestion_enabled   = var.streaming_ingestion_enabled
  auto_stop_enabled             = var.auto_stop_enabled
  double_encryption_enabled     = var.double_encryption_enabled
  public_network_access_enabled = var.public_network_access_enabled
}

# --- CMK Customer Managed Key ---

resource "azurerm_kusto_cluster_customer_managed_key" "this" {
  count = var.enable_cmk ? 1 : 0

  cluster_id    = azurerm_kusto_cluster.this.id
  key_vault_id  = var.cmk_key_vault_id
  key_name      = var.cmk_key_name
  user_identity = var.cmk_identity_id
}

# --- Databases ---

resource "azurerm_kusto_database" "this" {
  for_each = { for db in var.databases : db.name => db }

  name                = each.value.name
  resource_group_name = var.resource_group_name
  location            = var.location
  cluster_name        = azurerm_kusto_cluster.this.name
  hot_cache_period    = each.value.hot_cache_period
  soft_delete_period  = each.value.soft_delete_period
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
    private_connection_resource_id = azurerm_kusto_cluster.this.id
    subresource_names              = ["cluster"]
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

  name                       = "${var.cluster_name}-diagnostics"
  target_resource_id         = azurerm_kusto_cluster.this.id
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

  name       = "${var.cluster_name}-no-delete"
  scope      = azurerm_kusto_cluster.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Data Explorer cluster. Remove lock before deleting."
}
