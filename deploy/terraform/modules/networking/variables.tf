# =============================================================================
# Networking Module — Variables
# Mirrors: deploy/bicep shared networking modules (hub-spoke, DNS, NSG)
# =============================================================================

variable "resource_group_name" {
  description = "Name of the resource group."
  type        = string
}

variable "location" {
  description = "Azure region for all resources."
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}

# --- Virtual Networks ---

variable "vnets" {
  description = "List of virtual networks to create."
  type = list(object({
    name          = string
    address_space = list(string)
    subnets = list(object({
      name                                          = string
      address_prefixes                               = list(string)
      service_endpoints                              = optional(list(string), [])
      private_endpoint_network_policies             = optional(string, "Disabled")
      private_link_service_network_policies_enabled = optional(bool, false)
      delegation = optional(object({
        name         = string
        service_name = string
        actions      = list(string)
      }), null)
    }))
  }))
  default = []
}

# --- NSGs ---

variable "nsgs" {
  description = "Network Security Groups to create."
  type = list(object({
    name = string
    rules = list(object({
      name                       = string
      priority                   = number
      direction                  = string
      access                     = string
      protocol                   = string
      source_port_range          = optional(string, "*")
      destination_port_range     = optional(string, "*")
      source_address_prefix      = optional(string, "*")
      destination_address_prefix = optional(string, "*")
    }))
  }))
  default = []
}

# --- NSG to Subnet Associations ---

variable "nsg_subnet_associations" {
  description = "Map NSG names to subnet IDs for association."
  type = map(object({
    nsg_name  = string
    subnet_id = string
  }))
  default = {}
}

# --- VNet Peering ---

variable "vnet_peerings" {
  description = "VNet peering configurations."
  type = list(object({
    name                         = string
    vnet_name                    = string
    remote_vnet_id               = string
    allow_virtual_network_access = optional(bool, true)
    allow_forwarded_traffic      = optional(bool, true)
    allow_gateway_transit        = optional(bool, false)
    use_remote_gateways          = optional(bool, false)
  }))
  default = []
}

# --- Private DNS Zones ---

variable "private_dns_zones" {
  description = "Private DNS zones to create."
  type = list(object({
    name      = string
    vnet_link = optional(string, "")
  }))
  default = []
}

# --- Private DNS Zone VNet Links ---

variable "dns_zone_vnet_links" {
  description = "Links between DNS zones and VNets."
  type = list(object({
    name                 = string
    dns_zone_name        = string
    virtual_network_id   = string
    registration_enabled = optional(bool, false)
  }))
  default = []
}

# --- Resource Lock ---

variable "enable_resource_lock" {
  description = "Attach CanNotDelete resource locks to VNets."
  type        = bool
  default     = true
}
