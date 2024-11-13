# Log into Azure

Connect-AzAccount

# Set Default Subscription
Get-AzSubscription

Set-AzContext -SubscriptionId ""

# Test Bicep Deployment 
#https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-7.4

Test-AzDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -Debug 

Get-AzDeploymentWhatIfResult -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -ResultFormat "FullResourcePayloads"

New-AzSubscriptionDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -Debug 


# Deploy Spoke Networks

Test-AzDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.spokenetwork.dev.json" -Debug 

Get-AzDeploymentWhatIfResult -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.spokenetwork.dev.json"  -ResultFormat "FullResourcePayloads"


# Full Deployment
New-AzSubscriptionDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -Debug

#Spoke Network Deployment
# New-AzSubscriptionDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\modules\networking\spoke\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\modules\networking\spoke\params\params.spokenetwork.dev.json" -Debug



Get-AzSubscriptionDeployment | Remove-AzSubscriptionDeployment



#  Get information about a deployment and its operations
Connect-AzAccount
$token = (Get-AzAccessToken).Token
$token
$deploymentName = "1d0b1636-0d15-4939-964c-09298cbe1605"
$operations = Get-AzSubscriptionDeploymentOperation -DeploymentName $deploymentName


$failedOperations = $operations | Where-Object { $_.StatusCode -ne "OK" }
$failedOperations | ForEach-Object {
    Write-Output "Resource: $($_.Properties.TargetResource.ResourceName)"
    Write-Output "Status: $($_.Properties.StatusMessage.error.code)"
    Write-Output "Message: $($_.Properties.StatusMessage.error.message)"
}

$operationUri = "https://management.azure.com/subscriptions/a0d6cfbe-8dc6-49b2-80da-c2473a463a98/providers/Microsoft.Network/locations/eastus/operations/31aa0d56-f63a-456f-8179-e426c669f3af?api-version=2024-01-01"
$operationStatus = Invoke-RestMethod -Uri $operationUri -Method Get -Headers @{ "Authorization" = "Bearer $token" }
Write-Output $operationStatus




# Define your resource group and workspace name
$resourceGroup = "rg-alz-dev-logging"
$workspaceName = "alz-dev-dataObservability-logAnalyticsWorkspace"

# Get the list of available intelligence packs (solutions)
$availableSolutions = Get-AzOperationalInsightsIntelligencePack -ResourceGroupName $resourceGroup -WorkspaceName $workspaceName

# Display the list of available solutions
$availableSolutions 




# Define your resource group and workspace name
$resourceGroup = "rg-alz-dev-logging"
$workspaceName = "alz-dev-dataObservability-logAnalyticsWorkspace"

# Get the list of available solutions
$solutions = Get-AzOperationalInsightsIntelligencePack -ResourceGroupName $resourceGroup -WorkspaceName $workspaceName

# Filter and display the solutions that use OMSGallery
$solutions | Where-Object { $_.Enabled -eq 'True' } 

Get-AzOperationalInsightsIntelligencePacks  -ResourceGroupName $resourceGroup -WorkspaceName $workspaceName

Get-AzMonitorLogAnalyticsSolution

# Azure CLI 

az monitor log-analytics solution list 