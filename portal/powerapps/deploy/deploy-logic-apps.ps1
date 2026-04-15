<#
.SYNOPSIS
    Deploys CSA-in-a-Box Logic Apps ARM templates to Azure.

.DESCRIPTION
    This script deploys the three Logic App workflows (source registration,
    approval, notification) to a specified Azure resource group. It validates
    templates before deployment and provides status output.

.PARAMETER ResourceGroupName
    Azure resource group to deploy into.

.PARAMETER Location
    Azure region for the deployment. Defaults to 'eastus'.

.PARAMETER CosmosDbAccountName
    Name of the existing Cosmos DB account.

.PARAMETER DataFactoryResourceId
    Full resource ID of the Azure Data Factory instance.

.PARAMETER NotificationEmail
    Email address for notifications and approvals.

.PARAMETER EventGridTopicEndpoint
    Event Grid topic endpoint for the notification workflow.

.PARAMETER TeamsWebhookUrl
    Microsoft Teams incoming webhook URL.

.EXAMPLE
    .\deploy-logic-apps.ps1 -ResourceGroupName "rg-csa-portal" `
        -CosmosDbAccountName "cosmos-csa-dev" `
        -DataFactoryResourceId "/subscriptions/.../Microsoft.DataFactory/factories/adf-csa" `
        -NotificationEmail "team@contoso.com"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,

    [Parameter()]
    [string]$Location = "eastus",

    [Parameter(Mandatory = $true)]
    [string]$CosmosDbAccountName,

    [Parameter(Mandatory = $true)]
    [string]$DataFactoryResourceId,

    [Parameter(Mandatory = $true)]
    [string]$NotificationEmail,

    [Parameter()]
    [string]$EventGridTopicEndpoint = "",

    [Parameter()]
    [string]$TeamsWebhookUrl = ""
)

$ErrorActionPreference = "Stop"

# Resolve paths to ARM templates
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TemplateDir = Join-Path $ScriptDir "..\logic-apps"

$templates = @(
    @{
        Name = "Source Registration Workflow"
        File = "source-registration-workflow.json"
        Parameters = @{
            cosmosDbAccountName    = $CosmosDbAccountName
            cosmosDbDatabaseName   = "csainabox"
            cosmosDbContainerName  = "sources"
            dataFactoryResourceId  = $DataFactoryResourceId
            notificationEmail      = $NotificationEmail
        }
    },
    @{
        Name = "Approval Workflow"
        File = "approval-workflow.json"
        Parameters = @{
            cosmosDbAccountName    = $CosmosDbAccountName
            cosmosDbDatabaseName   = "csainabox"
            approverEmail          = $NotificationEmail
        }
    },
    @{
        Name = "Notification Workflow"
        File = "notification-workflow.json"
        Parameters = @{
            eventGridTopicEndpoint = $EventGridTopicEndpoint
            teamsWebhookUrl        = $TeamsWebhookUrl
            notificationEmail      = $NotificationEmail
        }
    }
)

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "CSA-in-a-Box Logic Apps Deployment" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Resource Group : $ResourceGroupName"
Write-Host "Location       : $Location"
Write-Host "Cosmos DB      : $CosmosDbAccountName"
Write-Host ""

# Verify Azure CLI login
Write-Host "Verifying Azure CLI authentication..." -ForegroundColor Yellow
try {
    $account = az account show 2>&1 | ConvertFrom-Json
    Write-Host "Logged in as: $($account.user.name) (Subscription: $($account.name))" -ForegroundColor Green
} catch {
    Write-Error "Not logged in to Azure CLI. Run 'az login' first."
    exit 1
}

# Ensure resource group exists
Write-Host "`nEnsuring resource group '$ResourceGroupName' exists..." -ForegroundColor Yellow
az group create --name $ResourceGroupName --location $Location --output none 2>$null
Write-Host "Resource group ready." -ForegroundColor Green

# Deploy each template
$deploymentResults = @()

foreach ($template in $templates) {
    $templatePath = Join-Path $TemplateDir $template.File
    $deploymentName = "deploy-$(($template.File -replace '\.json$', ''))-$(Get-Date -Format 'yyyyMMddHHmmss')"

    if (-not (Test-Path $templatePath)) {
        Write-Warning "Template not found: $templatePath — skipping."
        continue
    }

    Write-Host "`nDeploying: $($template.Name)..." -ForegroundColor Yellow
    Write-Host "  Template: $templatePath"
    Write-Host "  Deployment: $deploymentName"

    # Validate template
    Write-Host "  Validating template..." -ForegroundColor Gray
    $validateResult = az deployment group validate `
        --resource-group $ResourceGroupName `
        --template-file $templatePath `
        --parameters ($template.Parameters | ConvertTo-Json -Compress) `
        2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Warning "  Validation failed for $($template.Name):"
        Write-Warning "  $validateResult"
        $deploymentResults += @{ Name = $template.Name; Status = "VALIDATION_FAILED" }
        continue
    }

    Write-Host "  Validation passed." -ForegroundColor Green

    # Deploy
    $deployResult = az deployment group create `
        --resource-group $ResourceGroupName `
        --name $deploymentName `
        --template-file $templatePath `
        --parameters ($template.Parameters | ConvertTo-Json -Compress) `
        --output json 2>&1

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Deployed successfully." -ForegroundColor Green
        $deploymentResults += @{ Name = $template.Name; Status = "SUCCESS" }
    } else {
        Write-Warning "  Deployment failed for $($template.Name):"
        Write-Warning "  $deployResult"
        $deploymentResults += @{ Name = $template.Name; Status = "FAILED" }
    }
}

# Summary
Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "Deployment Summary" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

foreach ($result in $deploymentResults) {
    $color = if ($result.Status -eq "SUCCESS") { "Green" } else { "Red" }
    Write-Host "  $($result.Name): $($result.Status)" -ForegroundColor $color
}

$failCount = ($deploymentResults | Where-Object { $_.Status -ne "SUCCESS" }).Count
if ($failCount -gt 0) {
    Write-Host "`n$failCount deployment(s) failed." -ForegroundColor Red
    exit 1
} else {
    Write-Host "`nAll deployments succeeded." -ForegroundColor Green
    exit 0
}
