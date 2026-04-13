# =============================================================================
# Governance Module — Main Resources
# Mirrors: deploy/bicep/DMLZ/modules/Purview/purview.bicep
# Features: Purview account, Kafka (Event Hubs) integration,
#           private endpoints, diagnostics, resource locks
# =============================================================================

locals {
  managed_rg_name = var.managed_resource_group_name != "" ? var.managed_resource_group_name : "managed-rg-${var.purview_account_name}"
}

resource "azurerm_purview_account" "this" {
  name                = var.purview_account_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  public_network_enabled      = var.public_network_access_enabled
  managed_resource_group_name = local.managed_rg_name

  identity {
    type = "SystemAssigned"
  }
}

# --- Kafka Event Hub Namespace ---

resource "azurerm_eventhub_namespace" "kafka" {
  count = var.configure_kafka ? 1 : 0

  name                = var.kafka_namespace_name != "" ? var.kafka_namespace_name : "${var.purview_account_name}-kafka"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  sku      = "Standard"
  capacity = 1
}

resource "azurerm_eventhub" "kafka" {
  count = var.configure_kafka ? 1 : 0

  name              = "purview-kafka"
  namespace_id      = azurerm_eventhub_namespace.kafka[0].id
  partition_count   = 1
  message_retention = 7
}

# --- RBAC: Purview → Event Hubs Data Owner ---

resource "azurerm_role_assignment" "purview_eh_data_owner" {
  count = var.configure_kafka ? 1 : 0

  scope                = azurerm_eventhub_namespace.kafka[0].id
  role_definition_name = "Azure Event Hubs Data Owner"
  principal_id         = azurerm_purview_account.this.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# --- RBAC: Purview → Event Hubs Data Sender ---

resource "azurerm_role_assignment" "purview_eh_data_sender" {
  count = var.configure_kafka ? 1 : 0

  scope                = azurerm_eventhub_namespace.kafka[0].id
  role_definition_name = "Azure Event Hubs Data Sender"
  principal_id         = azurerm_purview_account.this.identity[0].principal_id
  principal_type       = "ServicePrincipal"
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
    private_connection_resource_id = azurerm_purview_account.this.id
    subresource_names              = [each.value.subresource]
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

  name                       = "${var.purview_account_name}-diagnostics"
  target_resource_id         = azurerm_purview_account.this.id
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

  name       = "${var.purview_account_name}-no-delete"
  scope      = azurerm_purview_account.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Purview account. Remove lock before deleting."
}
