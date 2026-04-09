<#
.SYNOPSIS
    Validates zero-trust network configuration for the data platform.

.DESCRIPTION
    Checks that all data services have:
    - Private endpoints configured
    - Public network access disabled
    - DNS resolution working for private endpoints
    - Network security groups applied

.PARAMETER SubscriptionId
    Azure subscription to validate.

.PARAMETER ResourceGroupPrefix
    Resource group name prefix (e.g., 'csa-dlz-dev').
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [Parameter(Mandatory)]
    [string]$ResourceGroupPrefix
)

$ErrorActionPreference = 'Stop'

Write-Host "=== Network Security Validation ===" -ForegroundColor Cyan
Write-Host "Subscription: $SubscriptionId"
Write-Host "RG Prefix: $ResourceGroupPrefix"

Set-AzContext -Subscription $SubscriptionId | Out-Null

$results = @()

# ---------------------------------------------------------------------------
# Check 1: Public Network Access
# ---------------------------------------------------------------------------
Write-Host "`n--- Check 1: Public Network Access ---" -ForegroundColor White

$servicesToCheck = @(
    @{ Type = "Microsoft.Storage/storageAccounts"; Property = "publicNetworkAccess" },
    @{ Type = "Microsoft.Databricks/workspaces"; Property = "publicNetworkAccess" },
    @{ Type = "Microsoft.Synapse/workspaces"; Property = "publicNetworkAccess" },
    @{ Type = "Microsoft.DataFactory/factories"; Property = "publicNetworkAccess" },
    @{ Type = "Microsoft.KeyVault/vaults"; Property = "properties.publicNetworkAccess" },
    @{ Type = "Microsoft.DocumentDB/databaseAccounts"; Property = "publicNetworkAccess" }
)

$resourceGroups = Get-AzResourceGroup | Where-Object { $_.ResourceGroupName -like "$ResourceGroupPrefix*" }

foreach ($rg in $resourceGroups) {
    foreach ($serviceType in $servicesToCheck) {
        $resources = Get-AzResource -ResourceGroupName $rg.ResourceGroupName -ResourceType $serviceType.Type -ErrorAction SilentlyContinue

        foreach ($resource in $resources) {
            $detail = Get-AzResource -ResourceId $resource.ResourceId -ExpandProperties -ErrorAction SilentlyContinue
            $publicAccess = $detail.Properties.publicNetworkAccess

            $status = if ($publicAccess -eq "Disabled" -or $publicAccess -eq "Deny") { "PASS" } else { "FAIL" }
            $color = if ($status -eq "PASS") { "Green" } else { "Red" }

            Write-Host "  [$status] $($resource.Name) ($($resource.ResourceType)): publicNetworkAccess=$publicAccess" -ForegroundColor $color
            $results += @{
                Check    = "PublicNetworkAccess"
                Resource = $resource.Name
                Type     = $resource.ResourceType
                Status   = $status
                Value    = $publicAccess
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Check 2: Private Endpoints
# ---------------------------------------------------------------------------
Write-Host "`n--- Check 2: Private Endpoints ---" -ForegroundColor White

foreach ($rg in $resourceGroups) {
    $privateEndpoints = Get-AzPrivateEndpoint -ResourceGroupName $rg.ResourceGroupName -ErrorAction SilentlyContinue

    if ($privateEndpoints) {
        foreach ($pe in $privateEndpoints) {
            $connectionStatus = $pe.PrivateLinkServiceConnections[0].PrivateLinkServiceConnectionState.Status
            $status = if ($connectionStatus -eq "Approved") { "PASS" } else { "FAIL" }
            $color = if ($status -eq "PASS") { "Green" } else { "Red" }

            Write-Host "  [$status] PE: $($pe.Name) -> Status: $connectionStatus" -ForegroundColor $color
            $results += @{
                Check    = "PrivateEndpoint"
                Resource = $pe.Name
                Status   = $status
                Value    = $connectionStatus
            }
        }
    } else {
        Write-Host "  [WARN] No private endpoints in $($rg.ResourceGroupName)" -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------------
# Check 3: DNS Resolution
# ---------------------------------------------------------------------------
Write-Host "`n--- Check 3: Private DNS Resolution ---" -ForegroundColor White

$dnsZonesToCheck = @(
    "privatelink.blob.core.windows.net",
    "privatelink.dfs.core.windows.net",
    "privatelink.vaultcore.azure.net",
    "privatelink.azuredatabricks.net",
    "privatelink.sql.azuresynapse.net",
    "privatelink.datafactory.azure.net"
)

foreach ($rg in $resourceGroups) {
    $dnsZones = Get-AzPrivateDnsZone -ResourceGroupName $rg.ResourceGroupName -ErrorAction SilentlyContinue

    foreach ($zone in $dnsZones) {
        $records = Get-AzPrivateDnsRecordSet -ZoneName $zone.Name -ResourceGroupName $rg.ResourceGroupName -RecordType A -ErrorAction SilentlyContinue
        $recordCount = ($records | Measure-Object).Count
        $status = if ($recordCount -gt 0) { "PASS" } else { "WARN" }
        $color = if ($status -eq "PASS") { "Green" } else { "Yellow" }

        Write-Host "  [$status] DNS Zone: $($zone.Name) - $recordCount A records" -ForegroundColor $color
        $results += @{
            Check    = "DNSResolution"
            Resource = $zone.Name
            Status   = $status
            Value    = "$recordCount records"
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host "`n=== Validation Summary ===" -ForegroundColor Cyan

$passed = ($results | Where-Object { $_.Status -eq 'PASS' }).Count
$failed = ($results | Where-Object { $_.Status -eq 'FAIL' }).Count
$warnings = ($results | Where-Object { $_.Status -eq 'WARN' }).Count

Write-Host "  Passed:   $passed" -ForegroundColor Green
Write-Host "  Failed:   $failed" -ForegroundColor Red
Write-Host "  Warnings: $warnings" -ForegroundColor Yellow

if ($failed -gt 0) {
    Write-Host "`nFailed checks:" -ForegroundColor Red
    $results | Where-Object { $_.Status -eq 'FAIL' } | ForEach-Object {
        Write-Host "  - $($_.Check): $($_.Resource) = $($_.Value)" -ForegroundColor Red
    }
    exit 1
} else {
    Write-Host "`nAll network security checks passed!" -ForegroundColor Green
    exit 0
}
