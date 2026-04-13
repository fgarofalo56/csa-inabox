# =============================================================================
# Stream Analytics Module — Main Resources
# Mirrors: deploy/bicep/DLZ/modules/streamanalytics/streamanalytics.bicep
# Features: Compatibility level 1.2, streaming units, diagnostics,
#           resource locks
# Note: CMK is via linked storage account (content_storage_policy)
# =============================================================================

resource "azurerm_stream_analytics_job" "this" {
  name                = var.job_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  streaming_units     = var.streaming_units
  compatibility_level = var.compatibility_level
  content_storage_policy = var.content_storage_policy

  identity {
    type = "SystemAssigned"
  }

  transformation_query = var.transformation_query
}

# --- Diagnostic Settings ---

resource "azurerm_monitor_diagnostic_setting" "this" {
  count = var.log_analytics_workspace_id != "" ? 1 : 0

  name                       = "${var.job_name}-diagnostics"
  target_resource_id         = azurerm_stream_analytics_job.this.id
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

  name       = "${var.job_name}-no-delete"
  scope      = azurerm_stream_analytics_job.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Stream Analytics job. Remove lock before deleting."
}
