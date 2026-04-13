# =============================================================================
# Storage Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/storage/storage.bicep
# Features: HNS (Data Lake Gen2), network rules, private endpoints,
#           diagnostics, resource locks, CMK encryption
# =============================================================================

# --- Storage Account ---

resource "azurerm_storage_account" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  account_tier             = var.account_tier
  account_replication_type = var.account_replication_type
  account_kind             = var.account_kind
  access_tier              = var.access_tier
  is_hns_enabled           = var.is_hns_enabled
  min_tls_version          = var.min_tls_version

  allow_nested_items_to_be_public  = var.allow_blob_public_access
  shared_access_key_enabled        = var.shared_access_key_enabled
  infrastructure_encryption_enabled = var.infrastructure_encryption_enabled
  public_network_access_enabled    = false

  identity {
    type         = var.enable_cmk ? "SystemAssigned, UserAssigned" : "SystemAssigned"
    identity_ids = var.enable_cmk ? [var.cmk_identity_id] : []
  }

  dynamic "customer_managed_key" {
    for_each = var.enable_cmk ? [1] : []
    content {
      key_vault_key_id          = var.cmk_key_vault_key_id
      user_assigned_identity_id = var.cmk_identity_id
    }
  }

  network_rules {
    default_action = "Deny"
    bypass         = ["Metrics", "AzureServices", "Logging"]
    ip_rules       = []
  }

  blob_properties {
    delete_retention_policy {
      days = var.blob_soft_delete_retention_days
    }
    container_delete_retention_policy {
      days = var.container_soft_delete_retention_days
    }
    versioning_enabled  = var.versioning_enabled
    change_feed_enabled = var.change_feed_enabled
    change_feed_retention_in_days = var.change_feed_retention_in_days
  }
}

# --- ADLS Gen2 File Systems ---

resource "azurerm_storage_data_lake_gen2_filesystem" "this" {
  for_each           = toset(var.file_system_names)
  name               = each.value
  storage_account_id = azurerm_storage_account.this.id
}

# --- Lifecycle Management ---

resource "azurerm_storage_management_policy" "this" {
  storage_account_id = azurerm_storage_account.this.id

  rule {
    name    = "default-tiering"
    enabled = true
    filters {
      blob_types = ["blockBlob"]
    }
    actions {
      base_blob {
        tier_to_cool_after_days_since_modification_greater_than = var.lifecycle_cool_after_days
      }
      snapshot {
        change_tier_to_cool_after_days_since_creation = var.lifecycle_cool_after_days
      }
      version {
        change_tier_to_cool_after_days_since_creation = var.lifecycle_cool_after_days
      }
    }
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
    private_connection_resource_id = azurerm_storage_account.this.id
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

resource "azurerm_monitor_diagnostic_setting" "account" {
  count = var.log_analytics_workspace_id != "" ? 1 : 0

  name                       = "${var.name}-diagnostics"
  target_resource_id         = azurerm_storage_account.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  metric {
    category = "Transaction"
    enabled  = true
  }
}

resource "azurerm_monitor_diagnostic_setting" "blob" {
  count = var.log_analytics_workspace_id != "" ? 1 : 0

  name                       = "${var.name}-blob-diagnostics"
  target_resource_id         = "${azurerm_storage_account.this.id}/blobServices/default"
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category_group = "allLogs"
  }

  metric {
    category = "Transaction"
    enabled  = true
  }
}

# --- Resource Lock ---

resource "azurerm_management_lock" "this" {
  count = var.enable_resource_lock ? 1 : 0

  name       = "${var.name}-no-delete"
  scope      = azurerm_storage_account.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: data-lake storage account. Remove lock before deleting."
}
