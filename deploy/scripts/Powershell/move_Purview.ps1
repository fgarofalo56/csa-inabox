<#
.SYNOPSIS
    Moves a Purview account and related resources between Azure subscriptions.

.DESCRIPTION
    Moves all resources in a source resource group to a destination subscription
    and resource group. Designed for migrating Purview accounts between subscriptions.

.PARAMETER SourceSubscriptionId
    The subscription ID where the Purview account currently resides.

.PARAMETER DestinationSubscriptionId
    The subscription ID to move the Purview account to.

.PARAMETER SourceResourceGroup
    The resource group containing the Purview account.

.PARAMETER DestinationResourceGroup
    The target resource group in the destination subscription.

.PARAMETER PurviewAccountName
    The name of the Purview account to move.

.PARAMETER AzureEnvironment
    The Azure environment (AzureCloud, AzureUSGovernment). Default: AzureCloud.

.PARAMETER WhatIf
    Preview the move without executing it.

.EXAMPLE
    .\move_Purview.ps1 -SourceSubscriptionId "xxx" -DestinationSubscriptionId "yyy" `
        -SourceResourceGroup "rg-source" -DestinationResourceGroup "rg-dest" `
        -PurviewAccountName "my-purview" -WhatIf
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$SourceSubscriptionId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$DestinationSubscriptionId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$SourceResourceGroup,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$DestinationResourceGroup,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$PurviewAccountName,

    [ValidateSet('AzureCloud', 'AzureUSGovernment')]
    [string]$AzureEnvironment = 'AzureCloud'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    # Login to Azure
    Write-Host "Connecting to Azure ($AzureEnvironment)..."
    Connect-AzAccount -Environment $AzureEnvironment

    # Set the current subscription to the source subscription
    Write-Host "Setting context to source subscription: $SourceSubscriptionId"
    Set-AzContext -SubscriptionId $SourceSubscriptionId

    # Verify the Purview account exists
    $purviewAccount = Get-AzResource -ResourceGroupName $SourceResourceGroup -ResourceName $PurviewAccountName
    if (-not $purviewAccount) {
        throw "Purview account '$PurviewAccountName' not found in resource group '$SourceResourceGroup'"
    }
    Write-Host "Found Purview account: $($purviewAccount.Name) (Type: $($purviewAccount.ResourceType))"

    # List all resources in the resource group
    $resourcesToMove = Get-AzResource -ResourceGroupName $SourceResourceGroup
    if (-not $resourcesToMove) {
        throw "No resources found in resource group '$SourceResourceGroup'"
    }

    Write-Host "`nResources to move ($($resourcesToMove.Count)):"
    foreach ($resource in $resourcesToMove) {
        Write-Host "  - $($resource.Name) ($($resource.ResourceType))"
    }

    # Confirm before moving
    if ($PSCmdlet.ShouldProcess(
        "Move $($resourcesToMove.Count) resources from '$SourceResourceGroup' to '$DestinationResourceGroup' in subscription '$DestinationSubscriptionId'",
        "Are you sure you want to move these resources?",
        "Resource Move Confirmation")) {

        Write-Host "`nMoving resources..."
        Move-AzResource -ResourceId $resourcesToMove.ResourceId `
            -DestinationSubscriptionId $DestinationSubscriptionId `
            -DestinationResourceGroupName $DestinationResourceGroup `
            -Force

        Write-Host "Purview instance and related resources moved successfully!" -ForegroundColor Green
    }
    else {
        Write-Host "Move cancelled." -ForegroundColor Yellow
    }
}
catch {
    Write-Error "Failed to move Purview resources: $_"
    exit 1
}
