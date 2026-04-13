# =============================================================================
# Monitoring Module — Main Resources
# Features: Log Analytics workspace, Application Insights, solutions,
#           resource locks
# =============================================================================

# --- Log Analytics Workspace ---

resource "azurerm_log_analytics_workspace" "this" {
  name                = var.log_analytics_workspace_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
  sku                 = var.log_analytics_sku
  retention_in_days   = var.log_analytics_retention_in_days
  daily_quota_gb      = var.log_analytics_daily_quota_gb
}

# --- Application Insights ---

resource "azurerm_application_insights" "this" {
  count = var.deploy_app_insights ? 1 : 0

  name                = var.app_insights_name != "" ? var.app_insights_name : "${var.log_analytics_workspace_name}-appi"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
  workspace_id        = azurerm_log_analytics_workspace.this.id
  application_type    = var.app_insights_type
  local_authentication_disabled = var.app_insights_disable_local_auth
}

# --- Solutions ---

resource "azurerm_log_analytics_solution" "this" {
  for_each = { for s in var.solutions : s.solution_name => s }

  solution_name         = each.value.solution_name
  location              = var.location
  resource_group_name   = var.resource_group_name
  workspace_resource_id = azurerm_log_analytics_workspace.this.id
  workspace_name        = azurerm_log_analytics_workspace.this.name

  plan {
    publisher = each.value.publisher
    product   = each.value.product
  }
}

# --- Resource Lock ---

resource "azurerm_management_lock" "this" {
  count = var.enable_resource_lock ? 1 : 0

  name       = "${var.log_analytics_workspace_name}-no-delete"
  scope      = azurerm_log_analytics_workspace.this.id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Log Analytics workspace. Remove lock before deleting."
}
