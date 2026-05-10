# Databricks Networking Best Practices

> **[Home](../../../../README.md)** | **[Best Practices](../../README.md)** | **[Cross-Cutting](../README.md)** | **Databricks Networking**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Networking-blue?style=flat-square)

Network architecture and security patterns for Azure Databricks.

---

## Overview

Secure network configuration is essential for enterprise Databricks deployments, enabling private connectivity and compliance with security requirements.

---

## VNet Injection

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Customer VNet                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Databricks Delegated Subnets               │ │
│  │  ┌─────────────────┐    ┌─────────────────┐            │ │
│  │  │  Public Subnet  │    │ Private Subnet  │            │ │
│  │  │  (Host VMs)     │    │ (Containers)    │            │ │
│  │  │  10.0.1.0/24    │    │  10.0.2.0/24    │            │ │
│  │  └────────┬────────┘    └────────┬────────┘            │ │
│  └───────────┼──────────────────────┼─────────────────────┘ │
│              │                      │                       │
│  ┌───────────┴──────────────────────┴─────────────────────┐ │
│  │                    NSG / UDR                           │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Terraform Configuration

```hcl
# VNet with Databricks subnets
resource "azurerm_virtual_network" "databricks" {
  name                = "vnet-databricks-${var.environment}"
  location            = var.location
  resource_group_name = var.resource_group_name
  address_space       = ["10.0.0.0/16"]
}

resource "azurerm_subnet" "public" {
  name                 = "snet-databricks-public"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.databricks.name
  address_prefixes     = ["10.0.1.0/24"]

  delegation {
    name = "databricks-delegation"
    service_delegation {
      name = "Microsoft.Databricks/workspaces"
      actions = [
        "Microsoft.Network/virtualNetworks/subnets/join/action",
        "Microsoft.Network/virtualNetworks/subnets/prepareNetworkPolicies/action",
        "Microsoft.Network/virtualNetworks/subnets/unprepareNetworkPolicies/action"
      ]
    }
  }
}

resource "azurerm_subnet" "private" {
  name                 = "snet-databricks-private"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.databricks.name
  address_prefixes     = ["10.0.2.0/24"]

  delegation {
    name = "databricks-delegation"
    service_delegation {
      name = "Microsoft.Databricks/workspaces"
      actions = [
        "Microsoft.Network/virtualNetworks/subnets/join/action",
        "Microsoft.Network/virtualNetworks/subnets/prepareNetworkPolicies/action",
        "Microsoft.Network/virtualNetworks/subnets/unprepareNetworkPolicies/action"
      ]
    }
  }
}
```

---

## Private Link Configuration

### Private Endpoints

```hcl
# Databricks workspace with Private Link
resource "azurerm_databricks_workspace" "main" {
  name                        = "dbw-analytics-${var.environment}"
  resource_group_name         = var.resource_group_name
  location                    = var.location
  sku                         = "premium"

  public_network_access_enabled         = false
  network_security_group_rules_required = "NoAzureDatabricksRules"

  custom_parameters {
    no_public_ip                                         = true
    virtual_network_id                                   = azurerm_virtual_network.databricks.id
    public_subnet_name                                   = azurerm_subnet.public.name
    private_subnet_name                                  = azurerm_subnet.private.name
    public_subnet_network_security_group_association_id  = azurerm_subnet_network_security_group_association.public.id
    private_subnet_network_security_group_association_id = azurerm_subnet_network_security_group_association.private.id
  }
}

# UI/API Private Endpoint
resource "azurerm_private_endpoint" "databricks_ui" {
  name                = "pe-databricks-ui"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = azurerm_subnet.endpoints.id

  private_service_connection {
    name                           = "psc-databricks-ui"
    private_connection_resource_id = azurerm_databricks_workspace.main.id
    is_manual_connection           = false
    subresource_names              = ["databricks_ui_api"]
  }

  private_dns_zone_group {
    name                 = "databricks-dns"
    private_dns_zone_ids = [azurerm_private_dns_zone.databricks.id]
  }
}

# Backend Private Endpoint
resource "azurerm_private_endpoint" "databricks_backend" {
  name                = "pe-databricks-backend"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = azurerm_subnet.endpoints.id

  private_service_connection {
    name                           = "psc-databricks-backend"
    private_connection_resource_id = azurerm_databricks_workspace.main.id
    is_manual_connection           = false
    subresource_names              = ["browser_authentication"]
  }
}
```

### DNS Configuration

```hcl
resource "azurerm_private_dns_zone" "databricks" {
  name                = "privatelink.azuredatabricks.net"
  resource_group_name = var.resource_group_name
}

resource "azurerm_private_dns_zone_virtual_network_link" "databricks" {
  name                  = "vnet-link-databricks"
  resource_group_name   = var.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.databricks.name
  virtual_network_id    = azurerm_virtual_network.hub.id
  registration_enabled  = false
}
```

---

## Network Security

### NSG Rules

```hcl
resource "azurerm_network_security_group" "databricks" {
  name                = "nsg-databricks"
  location            = var.location
  resource_group_name = var.resource_group_name

  # Required for Databricks control plane
  security_rule {
    name                       = "AllowDatabricksControlPlane"
    priority                   = 100
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "AzureDatabricks"
  }

  # Required for Azure Storage
  security_rule {
    name                       = "AllowAzureStorage"
    priority                   = 110
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "Storage"
  }

  # Required for Azure SQL (metastore)
  security_rule {
    name                       = "AllowAzureSQL"
    priority                   = 120
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3306"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "Sql"
  }

  # Required for EventHub (log delivery)
  security_rule {
    name                       = "AllowEventHub"
    priority                   = 130
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "9093"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "EventHub"
  }
}
```

---

## Connectivity Patterns

### Hub-Spoke Integration

```hcl
# Peering from Databricks VNet to Hub
resource "azurerm_virtual_network_peering" "databricks_to_hub" {
  name                      = "peer-databricks-to-hub"
  resource_group_name       = var.resource_group_name
  virtual_network_name      = azurerm_virtual_network.databricks.name
  remote_virtual_network_id = var.hub_vnet_id

  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
  use_remote_gateways          = true
}

# UDR for forced tunneling
resource "azurerm_route_table" "databricks" {
  name                = "rt-databricks"
  location            = var.location
  resource_group_name = var.resource_group_name

  route {
    name                   = "to-firewall"
    address_prefix         = "0.0.0.0/0"
    next_hop_type          = "VirtualAppliance"
    next_hop_in_ip_address = var.firewall_ip
  }

  # Bypass firewall for Databricks control plane
  route {
    name           = "adb-controlplane"
    address_prefix = "AzureDatabricks"
    next_hop_type  = "Internet"
  }
}
```

---

## Troubleshooting

### Connectivity Tests

```python
# Test connectivity from Databricks cluster
def test_connectivity():
    """Verify network connectivity."""
    import socket

    endpoints = [
        ("Storage", "youraccount.blob.core.windows.net", 443),
        ("SQL", "youraccount.database.windows.net", 1433),
        ("KeyVault", "yourvault.vault.azure.net", 443),
    ]

    for name, host, port in endpoints:
        try:
            socket.create_connection((host, port), timeout=5)
            print(f"✓ {name}: Connected")
        except Exception as e:
            print(f"✗ {name}: Failed - {e}")

test_connectivity()
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Cluster startup timeout | NSG blocking | Check Databricks service tags |
| Cannot access storage | Missing private endpoint | Configure storage PE |
| Authentication failures | DNS resolution | Verify private DNS zones |

---

## Related Documentation

- [Databricks Best Practices](../../service-specific/databricks/README.md)
- [Network Security](../../../../best-practices/network-security/README.md)
- [Private Link Architecture](../../../../architecture/private-link-architecture/README.md)

---

*Last Updated: January 2025*
