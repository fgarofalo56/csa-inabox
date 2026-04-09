<#
.SYNOPSIS
    Configures Cosmos DB network ACL bypass for Synapse integration.

.DESCRIPTION
    Updates a Cosmos DB account to allow Azure Services bypass and adds a specific
    Synapse workspace as an allowed resource for analytical store access.

.PARAMETER CosmosDBAccountName
    The name of the Cosmos DB account to configure.

.PARAMETER ResourceGroupName
    The resource group containing the Cosmos DB account.

.PARAMETER SynapseWorkspaceResourceId
    The full resource ID of the Synapse workspace to allow access.

.EXAMPLE
    .\cosmosDB.ps1 -CosmosDBAccountName "my-cosmos" -ResourceGroupName "rg-cosmos" `
        -SynapseWorkspaceResourceId "/subscriptions/xxx/resourceGroups/yyy/providers/Microsoft.Synapse/workspaces/zzz"

.LINK
    https://learn.microsoft.com/en-us/azure/cosmos-db/analytical-store-private-endpoints#using-synapse-serverless-sql-pools
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$CosmosDBAccountName,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroupName,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$SynapseWorkspaceResourceId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    # Verify account exists
    $account = Get-AzCosmosDBAccount -Name $CosmosDBAccountName -ResourceGroupName $ResourceGroupName
    if (-not $account) {
        throw "Cosmos DB account '$CosmosDBAccountName' not found in resource group '$ResourceGroupName'"
    }

    Write-Host "Configuring network ACL bypass for Cosmos DB account: $CosmosDBAccountName"
    Write-Host "  Allowing Synapse workspace: $SynapseWorkspaceResourceId"

    Update-AzCosmosDBAccount `
        -Name $CosmosDBAccountName `
        -ResourceGroupName $ResourceGroupName `
        -NetworkAclBypass AzureServices `
        -NetworkAclBypassResourceId $SynapseWorkspaceResourceId

    Write-Host "Cosmos DB network ACL bypass configured successfully." -ForegroundColor Green
}
catch {
    Write-Error "Failed to configure Cosmos DB: $_"
    exit 1
}
