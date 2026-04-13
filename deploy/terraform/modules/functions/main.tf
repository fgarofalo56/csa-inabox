# =============================================================================
# Functions Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/functions/functions.bicep
# Features: App Service Plan, Function App (Linux/Windows), App Insights,
#           VNet integration, private endpoints, diagnostics, resource locks
# Note: CMK is inherited from the linked storage account
# =============================================================================

# --- App Service Plan ---

resource "azurerm_service_plan" "this" {
  name                = "${var.function_app_name}-plan"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
  os_type             = var.os_type
  sku_name            = var.plan_sku
}

# --- Linux Function App ---

resource "azurerm_linux_function_app" "this" {
  count = var.os_type == "Linux" ? 1 : 0

  name                = var.function_app_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
  service_plan_id     = azurerm_service_plan.this.id

  storage_account_name          = var.storage_account_name
  storage_account_access_key    = var.storage_uses_managed_identity ? null : var.storage_account_access_key
  storage_uses_managed_identity = var.storage_uses_managed_identity
  https_only                    = true
  public_network_access_enabled = false

  virtual_network_subnet_id = var.enable_vnet_integration ? var.vnet_integration_subnet_id : null

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_insights_connection_string = var.application_insights_connection_string
    application_insights_key               = var.application_insights_key

    application_stack {
      python_version = var.runtime == "python" ? var.runtime_version : null
      node_version   = var.runtime == "node" ? var.runtime_version : null
      dotnet_version = var.runtime == "dotnet" ? var.runtime_version : null
      java_version   = var.runtime == "java" ? var.runtime_version : null
    }
  }
}

# --- Windows Function App ---

resource "azurerm_windows_function_app" "this" {
  count = var.os_type == "Windows" ? 1 : 0

  name                = var.function_app_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
  service_plan_id     = azurerm_service_plan.this.id

  storage_account_name          = var.storage_account_name
  storage_account_access_key    = var.storage_uses_managed_identity ? null : var.storage_account_access_key
  storage_uses_managed_identity = var.storage_uses_managed_identity
  https_only                    = true
  public_network_access_enabled = false

  virtual_network_subnet_id = var.enable_vnet_integration ? var.vnet_integration_subnet_id : null

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_insights_connection_string = var.application_insights_connection_string
    application_insights_key               = var.application_insights_key

    application_stack {
      dotnet_version = var.runtime == "dotnet" ? var.runtime_version : null
      node_version   = var.runtime == "node" ? var.runtime_version : null
      java_version   = var.runtime == "java" ? var.runtime_version : null
    }
  }
}

# --- Locals for conditional resource references ---

locals {
  function_app_id           = var.os_type == "Linux" ? azurerm_linux_function_app.this[0].id : azurerm_windows_function_app.this[0].id
  function_app_name         = var.os_type == "Linux" ? azurerm_linux_function_app.this[0].name : azurerm_windows_function_app.this[0].name
  identity_principal_id     = var.os_type == "Linux" ? azurerm_linux_function_app.this[0].identity[0].principal_id : azurerm_windows_function_app.this[0].identity[0].principal_id
  default_hostname          = var.os_type == "Linux" ? azurerm_linux_function_app.this[0].default_hostname : azurerm_windows_function_app.this[0].default_hostname
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
    private_connection_resource_id = local.function_app_id
    subresource_names              = ["sites"]
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

  name                       = "${var.function_app_name}-diagnostics"
  target_resource_id         = local.function_app_id
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

  name       = "${var.function_app_name}-no-delete"
  scope      = local.function_app_id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Function App. Remove lock before deleting."
}
