# =============================================================================
# DLZ (Data Landing Zone) — Main Orchestrator
# Mirrors: deploy/bicep/DLZ/main.bicep
# Wires all modules together with proper dependency ordering.
# =============================================================================

locals {
  basename       = lower("${var.prefix}-${var.environment}")
  location_short = lower(replace(var.location, " ", ""))

  default_tags = {
    Owner          = "Azure Landing Zone & Cloud Scale Analytics Scenario"
    Project        = "Azure Demo ALZ & CSA"
    Environment    = var.environment
    Toolkit        = "Terraform"
    PrimaryContact = var.primary_contact
    CostCenter     = var.cost_center
  }

  tags = merge(local.default_tags, var.extra_tags)
}

# =============================================================================
# Resource Groups
# =============================================================================

resource "azurerm_resource_group" "storage" {
  count    = var.deploy_storage ? 1 : 0
  name     = "rg-${local.basename}-storage-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "cosmosdb" {
  count    = var.deploy_cosmosdb ? 1 : 0
  name     = "rg-${local.basename}-cosmosdb-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "synapse" {
  count    = var.deploy_synapse ? 1 : 0
  name     = "rg-${local.basename}-synapse-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "databricks" {
  count    = var.deploy_databricks ? 1 : 0
  name     = "rg-${local.basename}-databricks-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "datafactory" {
  count    = var.deploy_data_factory ? 1 : 0
  name     = "rg-${local.basename}-adf-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "eventhubs" {
  count    = var.deploy_event_hubs ? 1 : 0
  name     = "rg-${local.basename}-eventhubs-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "dataexplorer" {
  count    = var.deploy_data_explorer ? 1 : 0
  name     = "rg-${local.basename}-adx-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "machinelearning" {
  count    = var.deploy_machine_learning ? 1 : 0
  name     = "rg-${local.basename}-ml-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "monitoring" {
  count    = var.deploy_app_insights ? 1 : 0
  name     = "rg-${local.basename}-monitoring-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "functions" {
  count    = var.deploy_functions ? 1 : 0
  name     = "rg-${local.basename}-functions-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "streamanalytics" {
  count    = var.deploy_stream_analytics ? 1 : 0
  name     = "rg-${local.basename}-asa-${local.location_short}"
  location = var.location
  tags     = local.tags
}

# =============================================================================
# Data Lake Storage
# =============================================================================

module "storage" {
  count  = var.deploy_storage ? 1 : 0
  source = "../modules/storage"

  name                = var.storage_account_name != "" ? var.storage_account_name : replace("${local.basename}lake", "-", "")
  resource_group_name = azurerm_resource_group.storage[0].name
  location            = var.location
  tags                = local.tags

  account_replication_type = var.storage_replication_type
  file_system_names        = var.storage_file_systems

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock
  enable_cmk                 = var.enable_cmk
  cmk_key_vault_key_id       = var.cmk_key_vault_key_id
  cmk_identity_id            = var.cmk_identity_id

  private_endpoints = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-lake-blob-pe"
      subnet_id           = var.private_endpoint_subnet_id
      subresource         = "blob"
      private_dns_zone_id = var.private_dns_zone_id_blob
    },
    {
      name                = "${local.basename}-lake-dfs-pe"
      subnet_id           = var.private_endpoint_subnet_id
      subresource         = "dfs"
      private_dns_zone_id = var.private_dns_zone_id_dfs
    }
  ] : []
}

# =============================================================================
# Cosmos DB
# =============================================================================

module "cosmosdb" {
  count  = var.deploy_cosmosdb ? 1 : 0
  source = "../modules/cosmosdb"

  account_name        = var.cosmosdb_account_name != "" ? var.cosmosdb_account_name : "${local.basename}-cosmos-${local.location_short}"
  resource_group_name = azurerm_resource_group.cosmosdb[0].name
  location            = var.location
  tags                = local.tags

  consistency_level = var.cosmosdb_consistency_level

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock
  enable_cmk                 = var.enable_cmk
  cmk_key_vault_key_id       = var.cmk_key_vault_key_id

  private_endpoints = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-cosmos-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_cosmosdb
    }
  ] : []
}

# =============================================================================
# Synapse Analytics
# =============================================================================

module "synapse" {
  count  = var.deploy_synapse ? 1 : 0
  source = "../modules/synapse"

  workspace_name      = "${local.basename}-synapse"
  resource_group_name = azurerm_resource_group.synapse[0].name
  location            = var.location
  tags                = local.tags

  storage_data_lake_gen2_filesystem_id = var.deploy_storage ? values(module.storage[0].file_system_ids)[0] : ""
  sql_administrator_login_password     = var.synapse_sql_admin_password

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock
  enable_cmk                 = var.enable_cmk

  private_endpoints_sql = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-synapse-sql-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_synapse_sql
    }
  ] : []

  private_endpoints_sql_ondemand = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-synapse-sqlod-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_synapse_sql
    }
  ] : []

  private_endpoints_dev = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-synapse-dev-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_synapse_dev
    }
  ] : []

  depends_on = [module.storage]
}

# =============================================================================
# Databricks
# =============================================================================

module "databricks" {
  count  = var.deploy_databricks ? 1 : 0
  source = "../modules/databricks"

  workspace_name      = "${local.basename}-dbw"
  resource_group_name = azurerm_resource_group.databricks[0].name
  location            = var.location
  tags                = local.tags

  vnet_id             = var.databricks_vnet_id
  public_subnet_name  = var.databricks_public_subnet_name
  private_subnet_name = var.databricks_private_subnet_name

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock
  enable_cmk                 = var.enable_cmk
  cmk_key_vault_key_id       = var.cmk_key_vault_key_id
  cmk_key_vault_id           = var.cmk_key_vault_id

  private_endpoints = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-dbw-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_databricks
    }
  ] : []
}

# =============================================================================
# Data Factory
# =============================================================================

module "datafactory" {
  count  = var.deploy_data_factory ? 1 : 0
  source = "../modules/datafactory"

  name                = "${local.basename}-adf"
  resource_group_name = azurerm_resource_group.datafactory[0].name
  location            = var.location
  tags                = local.tags

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock
  enable_cmk                 = var.enable_cmk
  cmk_key_vault_key_id       = var.cmk_key_vault_key_id
  cmk_identity_id            = var.cmk_identity_id

  private_endpoints_data_factory = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-adf-df-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_datafactory
    }
  ] : []

  private_endpoints_portal = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-adf-portal-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_adf_portal
    }
  ] : []
}

# =============================================================================
# Event Hubs
# =============================================================================

module "eventhubs" {
  count  = var.deploy_event_hubs ? 1 : 0
  source = "../modules/eventhubs"

  namespace_name      = "${local.basename}-ehns"
  resource_group_name = azurerm_resource_group.eventhubs[0].name
  location            = var.location
  tags                = local.tags

  event_hubs = var.event_hubs

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock
  enable_cmk                 = var.enable_cmk
  cmk_key_vault_key_id       = var.cmk_key_vault_key_id
  cmk_identity_id            = var.cmk_identity_id

  private_endpoints = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-ehns-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_eventhubs
    }
  ] : []
}

# =============================================================================
# Data Explorer (Kusto)
# =============================================================================

module "dataexplorer" {
  count  = var.deploy_data_explorer ? 1 : 0
  source = "../modules/dataexplorer"

  cluster_name        = replace("${local.basename}adx", "-", "")
  resource_group_name = azurerm_resource_group.dataexplorer[0].name
  location            = var.location
  tags                = local.tags

  sku_name  = var.data_explorer_sku
  databases = var.data_explorer_databases

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock
  enable_cmk                 = var.enable_cmk
  cmk_key_vault_key_id       = var.cmk_key_vault_key_id
  cmk_key_vault_id           = var.cmk_key_vault_id
  cmk_key_name               = var.cmk_key_name
  cmk_identity_id            = var.cmk_identity_id

  private_endpoints = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-adx-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_kusto
    }
  ] : []
}

# =============================================================================
# Application Insights (Monitoring)
# =============================================================================

module "monitoring" {
  count  = var.deploy_app_insights ? 1 : 0
  source = "../modules/monitoring"

  log_analytics_workspace_name = "${local.basename}-law"
  resource_group_name          = azurerm_resource_group.monitoring[0].name
  location                     = var.location
  tags                         = local.tags

  app_insights_name = "${local.basename}-appi"
  enable_resource_lock = var.enable_resource_lock
}

# =============================================================================
# Machine Learning
# =============================================================================

module "machinelearning" {
  count  = var.deploy_machine_learning ? 1 : 0
  source = "../modules/machinelearning"

  workspace_name      = "${local.basename}-ml"
  resource_group_name = azurerm_resource_group.machinelearning[0].name
  location            = var.location
  tags                = local.tags

  storage_account_id      = var.deploy_storage ? module.storage[0].storage_account_id : ""
  key_vault_id            = ""
  application_insights_id = var.deploy_app_insights ? module.monitoring[0].app_insights_id : ""

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock
  enable_cmk                 = var.enable_cmk
  cmk_key_vault_id           = var.cmk_key_vault_id
  cmk_key_vault_key_id       = var.cmk_key_vault_key_id
  cmk_identity_id            = var.cmk_identity_id

  private_endpoints = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-ml-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_ml
    }
  ] : []

  depends_on = [module.storage, module.monitoring]
}

# =============================================================================
# Azure Functions
# =============================================================================

module "functions" {
  count  = var.deploy_functions ? 1 : 0
  source = "../modules/functions"

  function_app_name   = "${local.basename}-func"
  resource_group_name = azurerm_resource_group.functions[0].name
  location            = var.location
  tags                = local.tags

  runtime  = var.functions_runtime
  plan_sku = var.functions_plan_sku

  storage_account_name                   = var.deploy_storage ? module.storage[0].storage_account_name : ""
  application_insights_connection_string = var.deploy_app_insights ? module.monitoring[0].app_insights_connection_string : ""
  application_insights_key               = var.deploy_app_insights ? module.monitoring[0].app_insights_instrumentation_key : ""

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock

  private_endpoints = var.private_endpoint_subnet_id != "" ? [
    {
      name                = "${local.basename}-func-pe"
      subnet_id           = var.private_endpoint_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_functions
    }
  ] : []

  depends_on = [module.storage, module.monitoring]
}

# =============================================================================
# Stream Analytics
# =============================================================================

module "streamanalytics" {
  count  = var.deploy_stream_analytics ? 1 : 0
  source = "../modules/streamanalytics"

  job_name            = "${local.basename}-asa"
  resource_group_name = azurerm_resource_group.streamanalytics[0].name
  location            = var.location
  tags                = local.tags

  streaming_units = var.stream_analytics_streaming_units

  log_analytics_workspace_id = var.log_analytics_workspace_id
  enable_resource_lock       = var.enable_resource_lock
}

# =============================================================================
# RBAC — Service-to-Service Identity Wiring
# Matches the role assignments in the Bicep DLZ main.bicep
# =============================================================================

# ADF → Storage: Storage Blob Data Contributor
resource "azurerm_role_assignment" "adf_to_storage" {
  count = var.deploy_data_factory && var.deploy_storage ? 1 : 0

  scope                = module.storage[0].storage_account_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = module.datafactory[0].identity_principal_id
  principal_type       = "ServicePrincipal"
  description          = "ADF managed identity -> Storage Blob Data Contributor on lake storage"
}

# Synapse → Storage: Storage Blob Data Contributor
resource "azurerm_role_assignment" "synapse_to_storage" {
  count = var.deploy_synapse && var.deploy_storage ? 1 : 0

  scope                = module.storage[0].storage_account_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = module.synapse[0].identity_principal_id
  principal_type       = "ServicePrincipal"
  description          = "Synapse managed identity -> Storage Blob Data Contributor on lake storage"
}

# Databricks → Storage: Storage Blob Data Contributor
resource "azurerm_role_assignment" "databricks_to_storage" {
  count = var.deploy_databricks && var.deploy_storage ? 1 : 0

  scope                = module.storage[0].storage_account_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = module.databricks[0].identity_principal_id
  principal_type       = "ServicePrincipal"
  description          = "Databricks managed identity -> Storage Blob Data Contributor on lake storage"
}

# Data Explorer → Storage: Storage Blob Data Reader
resource "azurerm_role_assignment" "adx_to_storage" {
  count = var.deploy_data_explorer && var.deploy_storage ? 1 : 0

  scope                = module.storage[0].storage_account_id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = module.dataexplorer[0].identity_principal_id
  principal_type       = "ServicePrincipal"
  description          = "Data Explorer managed identity -> Storage Blob Data Reader on lake storage"
}

# ADF → Event Hubs: Event Hubs Data Sender
resource "azurerm_role_assignment" "adf_to_eventhubs" {
  count = var.deploy_data_factory && var.deploy_event_hubs ? 1 : 0

  scope                = module.eventhubs[0].namespace_id
  role_definition_name = "Azure Event Hubs Data Sender"
  principal_id         = module.datafactory[0].identity_principal_id
  principal_type       = "ServicePrincipal"
  description          = "ADF managed identity -> Event Hubs Data Sender"
}

# Data Explorer → Event Hubs: Event Hubs Data Receiver
resource "azurerm_role_assignment" "adx_to_eventhubs" {
  count = var.deploy_data_explorer && var.deploy_event_hubs ? 1 : 0

  scope                = module.eventhubs[0].namespace_id
  role_definition_name = "Azure Event Hubs Data Receiver"
  principal_id         = module.dataexplorer[0].identity_principal_id
  principal_type       = "ServicePrincipal"
  description          = "Data Explorer managed identity -> Event Hubs Data Receiver"
}
