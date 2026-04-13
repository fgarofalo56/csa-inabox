# =============================================================================
# Event Hubs Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/eventhubs/eventhubs.bicep
# Features: Auto-inflate, Kafka, consumer groups, private endpoints,
#           diagnostics, resource locks, CMK encryption
# =============================================================================

resource "azurerm_eventhub_namespace" "this" {
  name                = var.namespace_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  sku                          = var.sku
  capacity                     = var.capacity
  auto_inflate_enabled         = var.sku == "Standard" ? var.auto_inflate_enabled : false
  maximum_throughput_units      = var.sku == "Standard" && var.auto_inflate_enabled ? var.maximum_throughput_units : 0
  kafka_enabled                = var.sku != "Basic" ? var.kafka_enabled : false
  local_authentication_enabled = var.local_authentication_enabled
  minimum_tls_version          = var.minimum_tls_version
  public_network_access_enabled = var.public_network_access_enabled

  identity {
    type         = var.enable_cmk ? "SystemAssigned, UserAssigned" : "SystemAssigned"
    identity_ids = var.enable_cmk ? [var.cmk_identity_id] : []
  }
}

# --- Customer Managed Key ---
# In azurerm v4, CMK for Event Hubs is a separate resource, not an inline block.

resource "azurerm_eventhub_namespace_customer_managed_key" "this" {
  count = var.enable_cmk ? 1 : 0

  eventhub_namespace_id             = azurerm_eventhub_namespace.this.id
  key_vault_key_ids                 = [var.cmk_key_vault_key_id]
  user_assigned_identity_id         = var.cmk_identity_id
  infrastructure_encryption_enabled = true
}

# --- Event Hubs ---

resource "azurerm_eventhub" "this" {
  for_each = { for eh in var.event_hubs : eh.name => eh }

  name              = each.value.name
  namespace_id      = azurerm_eventhub_namespace.this.id
  partition_count   = each.value.partition_count
  message_retention = each.value.message_retention_days
}

# --- Consumer Groups ---

locals {
  # Flatten event hubs × consumer groups into a map
  consumer_groups = merge([
    for eh in var.event_hubs : {
      for cg in eh.consumer_groups :
      "${eh.name}-${cg}" => {
        eventhub_name = eh.name
        group_name    = cg
      }
    }
  ]...)
}

resource "azurerm_eventhub_consumer_group" "this" {
  for_each = local.consumer_groups

  name         = each.value.group_name
  eventhub_name = each.value.eventhub_name
  namespace_id  = azurerm_eventhub_namespace.this.id
  user_metadata = "Consumer group for ${each.value.group_name} processing"

  depends_on = [azurerm_eventhub.this]
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
    private_connection_resource_id = azurerm_eventhub_namespace.this.id
    subresource_names              = ["namespace"]
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

  name                       = "${var.namespace_name}-diagnostics"
  target_resource_id         = azurerm_eventhub_namespace.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log { category = "ArchiveLogs" }
  enabled_log { category = "OperationalLogs" }
  enabled_log { category = "AutoScaleLogs" }
  enabled_log { category = "KafkaCoordinatorLogs" }
  enabled_log { category = "KafkaUserErrorLogs" }
  enabled_log { category = "EventHubVNetConnectionEvent" }
  enabled_log { category = "CustomerManagedKeyUserLogs" }
  enabled_log { category = "RuntimeAuditLogs" }
  enabled_log { category = "ApplicationMetricsLogs" }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}

# --- Resource Lock ---

resource "azurerm_management_lock" "this" {
  count = var.enable_resource_lock ? 1 : 0

  name       = "${var.namespace_name}-no-delete"
  scope      = azurerm_eventhub_namespace.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Event Hubs namespace. Remove lock before deleting."
}
