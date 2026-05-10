# Network Security Best Practices

[Home](../../README.md) > Best Practices > Network Security

!!! abstract "Overview"
    This guide covers network security best practices for Azure Synapse Analytics, including private endpoints, network isolation, firewall configuration, and secure connectivity patterns.

## 🔐 Network Security Architecture

Implementing robust network security is critical for protecting your Azure Synapse Analytics environment.

<div class="grid cards" markdown>

- 🔒 __Private Endpoints__

    ---

    Secure private connectivity to Azure services

    [→ Private endpoints](#private-endpoints)

- 🛡️ __Firewall Configuration__

    ---

    IP-based access control for Synapse workspace

    [→ Firewall setup](#firewall-configuration)

- 🛡️ __Network Isolation__

    ---

    Isolate workspaces and data stores in virtual networks

    [→ Network isolation](#network-isolation)

- 🚀 __Secure Connectivity__

    ---

    Establish secure connections between networks

    [→ Secure connections](#secure-connectivity)

</div>

## Private Endpoints

!!! warning "Security Alert"
    Public network access should be disabled for production environments to minimize the attack surface.

Azure Private Endpoints provide secure connectivity to Azure Synapse Analytics services from your virtual network:

1. __Private Endpoint Components__ for Synapse Analytics:
   - SQL on-demand endpoint
   - SQL dedicated pool endpoint
   - Development endpoint
   - Web endpoint
   - Serverless SQL endpoint
   - Spark endpoint

```json
{
  "name": "pe-synapse-sql",
  "properties": {
    "privateLinkServiceId": "/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Synapse/workspaces/<workspace-name>",
    "groupIds": ["Sql"],
    "privateLinkServiceConnectionState": {
      "status": "Approved",
      "description": "Auto-approved",
      "actionsRequired": "None"
    },
    "customDnsConfigs": [...]
  }
}
```

## Firewall Configuration

Configure IP firewall rules to restrict access to your Synapse workspace:

| Rule Type | Purpose | Example |
|-----------|---------|---------|
| Allow Azure Services | Enable Azure services to access Synapse | Set "Allow Azure services" to "Yes" |
| Client IP | Allow specific client IP addresses | `192.168.1.10` |
| IP Range | Allow a range of IP addresses | `192.168.1.0/24` |
| Corporate Network | Allow connections from corporate network | `10.0.0.0/8` |

!!! example "ARM Template for Firewall Rules"
    ```json
    {
      "name": "AllowCorporateNetwork",
      "type": "Microsoft.Synapse/workspaces/firewallRules",
      "apiVersion": "2021-06-01",
      "properties": {
        "startIpAddress": "10.0.0.0",
        "endIpAddress": "10.255.255.255"
      },
      "dependsOn": [
        "[resourceId('Microsoft.Synapse/workspaces', parameters('workspaceName'))]"
      ]
    }
    ```

## Network Isolation

![Secure Data Lakehouse Access Control](https://learn.microsoft.com/en-us/azure/architecture/example-scenario/analytics/media/secure-data-lakehouse-access-control.svg)

Implement these network isolation practices:

1. __VNet Integration__ - Place Synapse workspace in a virtual network
2. __Network Security Groups (NSGs)__ - Control traffic flow between subnets
3. __Service Endpoints__ - Secure Azure service connections
4. __Private DNS Zones__ - Resolve private endpoint DNS names
5. __Managed VNet__ - Enable managed virtual network for Synapse workspace

!!! tip "Best Practice"
    Use separate subnets for different Synapse components to apply granular NSG rules.

```powershell
# Example: Create managed private endpoint
$synapseWorkspace = "mysynapseworkspace"
$resourceGroup = "myresourcegroup"
$dataLakeAccountName = "mydatalakeaccount"
$subscriptionId = "<subscription-id>"

# Get workspace information
$workspace = Get-AzSynapseWorkspace -Name $synapseWorkspace -ResourceGroupName $resourceGroup

# Create managed private endpoint to storage account
$dataLakeId = "/subscriptions/$subscriptionId/resourceGroups/$resourceGroup/providers/Microsoft.Storage/storageAccounts/$dataLakeAccountName"

New-AzSynapseManagedPrivateEndpoint -WorkspaceName $synapseWorkspace `
  -Name "synapse-datalake-pe" `
  -DefinitionName "Microsoft.Storage/storageAccounts" `
  -TargetResourceId $dataLakeId
```

## Secure Connectivity

Establish secure connections between your on-premises network and Azure Synapse Analytics:

1. __ExpressRoute__ - Dedicated private connection to Azure
2. __VPN Gateway__ - Encrypted connection over public internet
3. __Azure Bastion__ - Secure RDP/SSH access to VMs
4. __Just-in-time Access__ - Temporary privileged access

!!! info "Integration Point"
    Azure Private Link and ExpressRoute work together to provide secure, private connectivity from on-premises environments to Azure Synapse.

![Secure Data Lakehouse Architecture](https://learn.microsoft.com/en-us/azure/architecture/example-scenario/analytics/media/secure-data-lakehouse-architecture.svg)

## Defense-in-Depth Strategy

Implement a defense-in-depth strategy for network security:

| Layer | Controls | Purpose |
|-------|----------|---------|
| Perimeter | Azure Firewall, DDoS Protection | Protect against external threats |
| Network | NSGs, Private Endpoints, UDRs | Control traffic flow |
| Resource | Workspace firewall, managed VNet | Restrict direct resource access |
| Data | Encryption, access policies | Protect data at rest and in transit |
| Identity | Azure AD, MFA, Conditional Access | Control authentication and authorization |

## Implementation Checklist

- [ ] Enable managed virtual network for Synapse workspace
- [ ] Configure private endpoints for all Synapse components
- [ ] Set up private DNS zones for private endpoints
- [ ] Configure NSGs with least-privilege access rules
- [ ] Implement Azure Firewall for outbound filtering
- [ ] Enable Azure DDoS Protection Standard
- [ ] Configure ExpressRoute or VPN connectivity
- [ ] Set up Azure Bastion for secure administrative access
- [ ] Implement Just-in-Time access for emergency scenarios
- [ ] Document network topology and security controls

## Related Resources

- [Azure Synapse Analytics network security](https://learn.microsoft.com/en-us/azure/synapse-analytics/security/synapse-workspace-managed-vnet)
- [Private endpoints for Azure Synapse](https://learn.microsoft.com/en-us/azure/synapse-analytics/security/how-to-connect-to-workspace-with-private-links)
- [Azure Private Link documentation](https://learn.microsoft.com/en-us/azure/private-link/)
