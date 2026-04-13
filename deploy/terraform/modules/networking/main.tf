# =============================================================================
# Networking Module — Main Resources
# Features: Virtual networks (hub-spoke), subnets with service endpoints
#           and delegations, NSGs, VNet peering, private DNS zones
# =============================================================================

# --- Virtual Networks ---

resource "azurerm_virtual_network" "this" {
  for_each = { for vnet in var.vnets : vnet.name => vnet }

  name                = each.value.name
  resource_group_name = var.resource_group_name
  location            = var.location
  address_space       = each.value.address_space
  tags                = var.tags
}

# --- Subnets ---

locals {
  subnets = merge([
    for vnet in var.vnets : {
      for subnet in vnet.subnets :
      "${vnet.name}-${subnet.name}" => merge(subnet, { vnet_name = vnet.name })
    }
  ]...)
}

resource "azurerm_subnet" "this" {
  for_each = local.subnets

  name                                          = each.value.name
  resource_group_name                           = var.resource_group_name
  virtual_network_name                          = each.value.vnet_name
  address_prefixes                              = each.value.address_prefixes
  service_endpoints                             = each.value.service_endpoints
  private_endpoint_network_policies             = each.value.private_endpoint_network_policies
  private_link_service_network_policies_enabled = each.value.private_link_service_network_policies_enabled

  dynamic "delegation" {
    for_each = each.value.delegation != null ? [each.value.delegation] : []
    content {
      name = delegation.value.name
      service_delegation {
        name    = delegation.value.service_name
        actions = delegation.value.actions
      }
    }
  }

  depends_on = [azurerm_virtual_network.this]
}

# --- Network Security Groups ---

resource "azurerm_network_security_group" "this" {
  for_each = { for nsg in var.nsgs : nsg.name => nsg }

  name                = each.value.name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  dynamic "security_rule" {
    for_each = each.value.rules
    content {
      name                       = security_rule.value.name
      priority                   = security_rule.value.priority
      direction                  = security_rule.value.direction
      access                     = security_rule.value.access
      protocol                   = security_rule.value.protocol
      source_port_range          = security_rule.value.source_port_range
      destination_port_range     = security_rule.value.destination_port_range
      source_address_prefix      = security_rule.value.source_address_prefix
      destination_address_prefix = security_rule.value.destination_address_prefix
    }
  }
}

# --- NSG to Subnet Associations ---

resource "azurerm_subnet_network_security_group_association" "this" {
  for_each = var.nsg_subnet_associations

  subnet_id                 = each.value.subnet_id
  network_security_group_id = azurerm_network_security_group.this[each.value.nsg_name].id
}

# --- VNet Peering ---

resource "azurerm_virtual_network_peering" "this" {
  for_each = { for p in var.vnet_peerings : p.name => p }

  name                         = each.value.name
  resource_group_name          = var.resource_group_name
  virtual_network_name         = each.value.vnet_name
  remote_virtual_network_id    = each.value.remote_vnet_id
  allow_virtual_network_access = each.value.allow_virtual_network_access
  allow_forwarded_traffic      = each.value.allow_forwarded_traffic
  allow_gateway_transit        = each.value.allow_gateway_transit
  use_remote_gateways          = each.value.use_remote_gateways

  depends_on = [azurerm_virtual_network.this]
}

# --- Private DNS Zones ---

resource "azurerm_private_dns_zone" "this" {
  for_each = { for zone in var.private_dns_zones : zone.name => zone }

  name                = each.value.name
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

# --- Private DNS Zone VNet Links ---

resource "azurerm_private_dns_zone_virtual_network_link" "this" {
  for_each = { for link in var.dns_zone_vnet_links : link.name => link }

  name                  = each.value.name
  resource_group_name   = var.resource_group_name
  private_dns_zone_name = each.value.dns_zone_name
  virtual_network_id    = each.value.virtual_network_id
  registration_enabled  = each.value.registration_enabled
  tags                  = var.tags

  depends_on = [azurerm_private_dns_zone.this]
}

# --- Resource Locks ---

resource "azurerm_management_lock" "vnet" {
  for_each = var.enable_resource_lock ? { for vnet in var.vnets : vnet.name => vnet } : {}

  name       = "${each.value.name}-no-delete"
  scope      = azurerm_virtual_network.this[each.key].id
  lock_level = "CanNotDelete"
  notes      = "CSA-in-a-Box: Virtual network. Remove lock before deleting."
}
