# =============================================================================
# Networking Module — Outputs
# =============================================================================

output "vnet_ids" {
  description = "Map of VNet names to their resource IDs."
  value       = { for k, v in azurerm_virtual_network.this : k => v.id }
}

output "vnet_names" {
  description = "Map of VNet names."
  value       = { for k, v in azurerm_virtual_network.this : k => v.name }
}

output "subnet_ids" {
  description = "Map of subnet keys (vnet-subnet) to their resource IDs."
  value       = { for k, v in azurerm_subnet.this : k => v.id }
}

output "nsg_ids" {
  description = "Map of NSG names to their resource IDs."
  value       = { for k, v in azurerm_network_security_group.this : k => v.id }
}

output "private_dns_zone_ids" {
  description = "Map of private DNS zone names to their resource IDs."
  value       = { for k, v in azurerm_private_dns_zone.this : k => v.id }
}
