<#
.SYNOPSIS
    Registers data sources in Microsoft Purview for automated scanning.

.DESCRIPTION
    Uses the Purview REST API to register ADLS, Synapse, Databricks, and Cosmos DB
    data sources for catalog scanning and classification.

.PARAMETER PurviewAccountName
    Name of the Purview account.

.PARAMETER SubscriptionId
    Azure subscription containing the data sources.

.PARAMETER ResourceGroupName
    Resource group containing the data sources.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$PurviewAccountName,

    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [Parameter(Mandatory)]
    [string]$ResourceGroupName,

    [string]$Environment = "dev"
)

$ErrorActionPreference = 'Stop'

Write-Host "=== Purview Source Registration ===" -ForegroundColor Cyan
Write-Host "Purview Account: $PurviewAccountName"
Write-Host "Subscription: $SubscriptionId"
Write-Host "Resource Group: $ResourceGroupName"
Write-Host "Environment: $Environment"

# Get access token for Purview
$token = (Get-AzAccessToken -ResourceUrl "https://purview.azure.net").Token
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type"  = "application/json"
}

$purviewEndpoint = "https://$PurviewAccountName.purview.azure.com"

function Register-PurviewSource {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$SourceName,
        [string]$SourceKind,
        [hashtable]$Properties
    )

    $body = @{
        kind       = $SourceKind
        properties = $Properties
    } | ConvertTo-Json -Depth 10

    $uri = "$purviewEndpoint/scan/datasources/$($SourceName)?api-version=2022-07-01-preview"

    if ($PSCmdlet.ShouldProcess($SourceName, "Register $SourceKind source")) {
        try {
            $response = Invoke-RestMethod -Uri $uri -Method Put -Headers $headers -Body $body
            Write-Host "  [REGISTERED] $SourceName ($SourceKind)" -ForegroundColor Green
            return $response
        } catch {
            Write-Host "  [FAILED] $SourceName : $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

function New-PurviewScanRuleset {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$RulesetName,
        [string]$SourceKind,
        [string[]]$ClassificationRules
    )

    $body = @{
        kind       = $SourceKind
        properties = @{
            description            = "CSA-in-a-Box scan ruleset for $SourceKind"
            excludedSystemClassifications = @()
            includedCustomClassificationRuleNames = $ClassificationRules
            scanRulesetType        = "Custom"
        }
    } | ConvertTo-Json -Depth 10

    $uri = "$purviewEndpoint/scan/scanrulesets/$($RulesetName)?api-version=2022-07-01-preview"

    if ($PSCmdlet.ShouldProcess($RulesetName, "Create scan ruleset")) {
        try {
            $response = Invoke-RestMethod -Uri $uri -Method Put -Headers $headers -Body $body
            Write-Host "  [CREATED] Scan ruleset: $RulesetName" -ForegroundColor Green
            return $response
        } catch {
            Write-Host "  [FAILED] Scan ruleset $RulesetName : $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

# ---------------------------------------------------------------------------
# Register Data Sources
# ---------------------------------------------------------------------------
Write-Host "`n--- Registering Data Sources ---" -ForegroundColor White

# 1. ADLS Gen2 Storage (all medallion containers)
$storageAccountName = "csadlz${Environment}st"
Register-PurviewSource -SourceName "adls-$storageAccountName" -SourceKind "AzureStorage" -Properties @{
    endpoint     = "https://$storageAccountName.dfs.core.windows.net/"
    resourceGroup = $ResourceGroupName
    subscriptionId = $SubscriptionId
    location     = "eastus"
    resourceName = $storageAccountName
    collection   = @{ referenceName = "root-collection"; type = "CollectionReference" }
}

# 2. Databricks Unity Catalog
$databricksWorkspace = "csadlz${Environment}dbw"
Register-PurviewSource -SourceName "databricks-$databricksWorkspace" -SourceKind "Databricks" -Properties @{
    workspaceUrl = "https://adb-0000000000000000.0.azuredatabricks.net"
    resourceGroup = $ResourceGroupName
    subscriptionId = $SubscriptionId
    location     = "eastus"
    collection   = @{ referenceName = "root-collection"; type = "CollectionReference" }
}

# 3. Synapse Analytics
$synapseName = "csadlz${Environment}syn"
Register-PurviewSource -SourceName "synapse-$synapseName" -SourceKind "AzureSynapseWorkspace" -Properties @{
    dedicatedSqlEndpoint = "$synapseName.sql.azuresynapse.net"
    serverlessSqlEndpoint = "$synapseName-ondemand.sql.azuresynapse.net"
    resourceGroup  = $ResourceGroupName
    subscriptionId = $SubscriptionId
    location       = "eastus"
    collection     = @{ referenceName = "root-collection"; type = "CollectionReference" }
}

# 4. Cosmos DB
$cosmosName = "csadlz${Environment}cosmos"
Register-PurviewSource -SourceName "cosmos-$cosmosName" -SourceKind "AzureCosmosDb" -Properties @{
    accountEndpoint = "https://$cosmosName.documents.azure.com:443/"
    resourceGroup   = $ResourceGroupName
    subscriptionId  = $SubscriptionId
    location        = "eastus"
    collection      = @{ referenceName = "root-collection"; type = "CollectionReference" }
}

# ---------------------------------------------------------------------------
# Create Scan Rulesets
# ---------------------------------------------------------------------------
Write-Host "`n--- Creating Scan Rulesets ---" -ForegroundColor White

New-PurviewScanRuleset -RulesetName "csa-adls-ruleset" -SourceKind "AzureStorage" -ClassificationRules @(
    "MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER",
    "MICROSOFT.PERSONAL.US.SOCIAL_SECURITY_NUMBER",
    "MICROSOFT.PERSONAL.EMAIL",
    "MICROSOFT.PERSONAL.PHONE_NUMBER",
    "MICROSOFT.PERSONAL.NAME"
)

New-PurviewScanRuleset -RulesetName "csa-synapse-ruleset" -SourceKind "AzureSynapseWorkspace" -ClassificationRules @(
    "MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER",
    "MICROSOFT.PERSONAL.US.SOCIAL_SECURITY_NUMBER",
    "MICROSOFT.PERSONAL.EMAIL"
)

Write-Host "`n=== Registration Complete ===" -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  1. Configure managed identity access on each data source"
Write-Host "  2. Create and schedule scans in Purview Studio"
Write-Host "  3. Review classification results after first scan"
