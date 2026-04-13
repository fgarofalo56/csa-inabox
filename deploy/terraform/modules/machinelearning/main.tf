# =============================================================================
# Machine Learning Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/machinelearning/machinelearning.bicep
# Features: Storage/KV/AppInsights/ACR dependencies, managed network,
#           optional compute instance, private endpoints, diagnostics,
#           resource locks, CMK encryption
# =============================================================================

resource "azurerm_machine_learning_workspace" "this" {
  name                = var.workspace_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  storage_account_id      = var.storage_account_id
  key_vault_id            = var.key_vault_id
  application_insights_id = var.application_insights_id != "" ? var.application_insights_id : null
  container_registry_id   = var.container_registry_id != "" ? var.container_registry_id : null

  public_network_access_enabled = var.public_network_access_enabled
  sku_name                      = var.sku_name

  managed_network {
    isolation_mode = var.managed_network_isolation_mode
  }

  identity {
    type         = var.enable_cmk ? "SystemAssigned, UserAssigned" : "SystemAssigned"
    identity_ids = var.enable_cmk ? [var.cmk_identity_id] : []
  }

  dynamic "encryption" {
    for_each = var.enable_cmk ? [1] : []
    content {
      key_vault_id                    = var.cmk_key_vault_id
      key_id                          = var.cmk_key_vault_key_id
      user_assigned_identity_id       = var.cmk_identity_id
    }
  }
}

# --- Compute Instance ---

resource "azurerm_machine_learning_compute_instance" "this" {
  count = var.deploy_compute_instance ? 1 : 0

  name                          = var.compute_instance_name
  machine_learning_workspace_id = azurerm_machine_learning_workspace.this.id
  virtual_machine_size          = var.compute_instance_vm_size
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
    private_connection_resource_id = azurerm_machine_learning_workspace.this.id
    subresource_names              = ["amlworkspace"]
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
  target_resource_id         = azurerm_machine_learning_workspace.this.id
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
  scope      = azurerm_machine_learning_workspace.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Machine Learning workspace. Remove lock before deleting."
}
