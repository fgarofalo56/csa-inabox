# =============================================================================
# Databricks Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/databricks/databricks.bicep
# Features: Premium workspace, VNet injection, no public IP,
#           CMK (managed services + managed disk), private endpoints,
#           diagnostics, resource locks
# =============================================================================

locals {
  managed_rg_name = var.managed_resource_group_name != "" ? var.managed_resource_group_name : "${var.workspace_name}-managed-rg"
}

resource "azurerm_databricks_workspace" "this" {
  name                = var.workspace_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
  sku                 = var.sku

  managed_resource_group_name           = local.managed_rg_name
  public_network_access_enabled         = var.public_network_access_enabled
  network_security_group_rules_required = var.network_security_group_rules_required

  # VNet injection
  dynamic "custom_parameters" {
    for_each = var.vnet_id != "" ? [1] : []
    content {
      virtual_network_id                                   = var.vnet_id
      public_subnet_name                                   = var.public_subnet_name
      private_subnet_name                                  = var.private_subnet_name
      no_public_ip                                         = var.no_public_ip
      public_subnet_network_security_group_association_id  = var.public_subnet_network_security_group_association_id
      private_subnet_network_security_group_association_id = var.private_subnet_network_security_group_association_id
    }
  }

  # Custom parameters without VNet injection
  dynamic "custom_parameters" {
    for_each = var.vnet_id == "" ? [1] : []
    content {
      no_public_ip = var.no_public_ip
    }
  }

  # CMK for managed services and managed disk
  # Note: Databricks uses SystemAssigned identity internally; CMK uses
  # the workspace's built-in identity, not a user-assigned one.
  managed_services_cmk_key_vault_key_id = var.enable_cmk ? var.cmk_key_vault_key_id : null
  managed_services_cmk_key_vault_id     = var.enable_cmk && var.cmk_key_vault_id != "" ? var.cmk_key_vault_id : null
  managed_disk_cmk_key_vault_key_id     = var.enable_cmk ? var.cmk_key_vault_key_id : null
  managed_disk_cmk_key_vault_id         = var.enable_cmk && var.cmk_key_vault_id != "" ? var.cmk_key_vault_id : null
  managed_disk_cmk_rotation_to_latest_version_enabled = var.enable_cmk ? true : null
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
    private_connection_resource_id = azurerm_databricks_workspace.this.id
    subresource_names              = ["databricks_ui_api"]
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
  target_resource_id         = azurerm_databricks_workspace.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log { category = "dbfs" }
  enabled_log { category = "clusters" }
  enabled_log { category = "accounts" }
  enabled_log { category = "jobs" }
  enabled_log { category = "notebook" }
  enabled_log { category = "ssh" }
  enabled_log { category = "workspace" }
  enabled_log { category = "secrets" }
  enabled_log { category = "sqlPermissions" }
  enabled_log { category = "instancePools" }
  enabled_log { category = "sqlanalytics" }
  enabled_log { category = "genie" }
  enabled_log { category = "globalInitScripts" }
  enabled_log { category = "iamRole" }
  enabled_log { category = "mlflowExperiment" }
  enabled_log { category = "featureStore" }
  enabled_log { category = "RemoteHistoryService" }
  enabled_log { category = "mlflowAcledArtifact" }
  enabled_log { category = "databrickssql" }
  enabled_log { category = "deltaPipelines" }
  enabled_log { category = "modelRegistry" }
  enabled_log { category = "repos" }
  enabled_log { category = "unityCatalog" }
  enabled_log { category = "gitCredentials" }
  enabled_log { category = "webTerminal" }
  enabled_log { category = "serverlessRealTimeInference" }
  enabled_log { category = "clusterLibraries" }
  enabled_log { category = "partnerHub" }
  enabled_log { category = "clamAVScan" }
  enabled_log { category = "capsule8Dataplane" }
}

# --- Resource Lock ---

resource "azurerm_management_lock" "this" {
  count = var.enable_resource_lock ? 1 : 0

  name       = "${var.workspace_name}-no-delete"
  scope      = azurerm_databricks_workspace.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Databricks workspace. Remove lock before deleting."
}
