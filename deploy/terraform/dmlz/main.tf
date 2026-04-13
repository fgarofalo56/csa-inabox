# =============================================================================
# DMLZ (Data Management Landing Zone) — Main Orchestrator
# Mirrors: deploy/bicep/DMLZ/main.bicep
# Deploys networking, monitoring, governance, keyvault, security modules.
# =============================================================================

locals {
  basename       = lower("${var.prefix}-${var.environment}")
  location_short = lower(replace(var.location, " ", ""))

  default_tags = {
    Owner          = "Azure Data Management Landing Zone & Cloud Scale Analytics Scenario"
    Project        = "Azure Demo DMLZ & CSA"
    Environment    = var.environment
    Toolkit        = "Terraform"
    PrimaryContact = var.primary_contact
    CostCenter     = var.cost_center
  }

  tags = merge(local.default_tags, var.extra_tags)

  # Resolve effective Log Analytics workspace ID
  effective_law_id = var.log_analytics_workspace_id != "" ? var.log_analytics_workspace_id : (
    var.deploy_monitoring ? module.monitoring[0].log_analytics_workspace_id : ""
  )

  # Resolve effective PE subnet ID
  effective_pe_subnet_id = var.private_endpoint_subnet_id != "" ? var.private_endpoint_subnet_id : (
    var.deploy_networking ? lookup(module.networking[0].subnet_ids, "${local.basename}-vnet-private-endpoints", "") : ""
  )
}

# =============================================================================
# Resource Groups
# =============================================================================

resource "azurerm_resource_group" "networking" {
  count    = var.deploy_networking ? 1 : 0
  name     = "rg-${local.basename}-networking-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "monitoring" {
  count    = var.deploy_monitoring ? 1 : 0
  name     = "rg-${local.basename}-monitoring-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "governance" {
  count    = var.deploy_governance ? 1 : 0
  name     = "rg-${local.basename}-governance-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "keyvault" {
  count    = var.deploy_keyvault ? 1 : 0
  name     = "rg-${local.basename}-keyvault-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "security" {
  count    = var.deploy_security ? 1 : 0
  name     = "rg-${local.basename}-security-${local.location_short}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "databricks" {
  count    = var.deploy_databricks ? 1 : 0
  name     = "rg-${local.basename}-databricks-gov-${local.location_short}"
  location = var.location
  tags     = local.tags
}

# =============================================================================
# Networking
# =============================================================================

module "networking" {
  count  = var.deploy_networking ? 1 : 0
  source = "../modules/networking"

  resource_group_name = azurerm_resource_group.networking[0].name
  location            = var.location
  tags                = local.tags
  enable_resource_lock = var.enable_resource_lock

  vnets = [
    {
      name          = "${local.basename}-vnet"
      address_space = var.vnet_address_space
      subnets       = var.subnets
    }
  ]

  private_dns_zones = [for zone in var.private_dns_zones : { name = zone }]

  dns_zone_vnet_links = [
    for zone in var.private_dns_zones : {
      name               = "${replace(zone, ".", "-")}-link"
      dns_zone_name      = zone
      virtual_network_id = "" # Will be linked after VNet creation
    }
  ]
}

# =============================================================================
# Monitoring
# =============================================================================

module "monitoring" {
  count  = var.deploy_monitoring ? 1 : 0
  source = "../modules/monitoring"

  log_analytics_workspace_name = var.log_analytics_workspace_name != "" ? var.log_analytics_workspace_name : "${local.basename}-law"
  resource_group_name          = azurerm_resource_group.monitoring[0].name
  location                     = var.location
  tags                         = local.tags

  log_analytics_retention_in_days = var.log_analytics_retention_in_days
  deploy_app_insights             = false
  enable_resource_lock            = var.enable_resource_lock
}

# =============================================================================
# Key Vault
# =============================================================================

module "keyvault" {
  count  = var.deploy_keyvault ? 1 : 0
  source = "../modules/keyvault"

  name                = var.keyvault_name != "" ? var.keyvault_name : "${local.basename}-kv"
  resource_group_name = azurerm_resource_group.keyvault[0].name
  location            = var.location
  tags                = local.tags

  log_analytics_workspace_id = local.effective_law_id
  enable_resource_lock       = var.enable_resource_lock

  private_endpoints = local.effective_pe_subnet_id != "" ? [
    {
      name                = "${local.basename}-kv-pe"
      subnet_id           = local.effective_pe_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_keyvault
    }
  ] : []

  depends_on = [module.networking, module.monitoring]
}

# =============================================================================
# Security (CMK Identity)
# =============================================================================

module "security" {
  count  = var.deploy_security ? 1 : 0
  source = "../modules/security"

  resource_group_name = azurerm_resource_group.security[0].name
  location            = var.location
  tags                = local.tags

  deploy_cmk_identity     = true
  cmk_identity_name       = "${local.basename}-cmk-identity"
  deploy_cmk_key          = var.deploy_keyvault
  key_vault_id            = var.deploy_keyvault ? module.keyvault[0].key_vault_id : ""
  assign_crypto_user_role = var.deploy_keyvault

  depends_on = [module.keyvault]
}

# =============================================================================
# Governance (Purview)
# =============================================================================

module "governance" {
  count  = var.deploy_governance ? 1 : 0
  source = "../modules/governance"

  purview_account_name = var.purview_account_name != "" ? var.purview_account_name : "${local.basename}-purview"
  resource_group_name  = azurerm_resource_group.governance[0].name
  location             = var.location
  tags                 = local.tags

  configure_kafka = var.purview_configure_kafka

  log_analytics_workspace_id = local.effective_law_id
  enable_resource_lock       = var.enable_resource_lock

  depends_on = [module.monitoring]
}

# =============================================================================
# Databricks (Governance / Unity Catalog)
# =============================================================================

module "databricks" {
  count  = var.deploy_databricks ? 1 : 0
  source = "../modules/databricks"

  workspace_name      = "${local.basename}-dbw-gov"
  resource_group_name = azurerm_resource_group.databricks[0].name
  location            = var.location
  tags                = local.tags

  vnet_id             = var.databricks_vnet_id
  public_subnet_name  = var.databricks_public_subnet_name
  private_subnet_name = var.databricks_private_subnet_name

  log_analytics_workspace_id = local.effective_law_id
  enable_resource_lock       = var.enable_resource_lock

  private_endpoints = local.effective_pe_subnet_id != "" ? [
    {
      name                = "${local.basename}-dbw-gov-pe"
      subnet_id           = local.effective_pe_subnet_id
      private_dns_zone_id = var.private_dns_zone_id_databricks
    }
  ] : []

  depends_on = [module.networking]
}
