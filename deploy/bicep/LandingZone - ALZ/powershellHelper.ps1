# Log into Azure
Connect-AzAccount

# Log into Azure US Government Cloud
Connect-AzAccount -Environment AzureUSGovernment


# Set Default Subscription
Get-AzSubscription

Set-AzContext -SubscriptionId "e093f4fd-5047-4ee4-968d-a56942c665f3"

# Enable Defgender for Cloud on all subscriptions using management group and powershell

# Get list of management groups using powershell
Get-AzManagementGroup
# Azure CLI
az login
az provider register --namespace Microsoft.Security --management-group-id "d1fc0498-f208-4b49-8376-beb9293acdf6"



# Loop through each id and register the provider run after deployment of ALZ with defaul workspace
# https://learn.microsoft.com/en-us/azure/defender-for-cloud/powershell-onboarding

$mg = Get-AzManagementGroup | Select-Object -Property Id, Name, DisplayName | Where-Object { $_.DisplayName -notlike "*Root*" } 
$defaulWorkspaceSub = "a60a2fdd-c133-4845-9beb-31f470bf3ef5"
$defaulWorkspaceRG = "rg-alz-dev-logging"
$defaulWorkspaceName = "alz-dev-dataObservability-logAnalyticsWorkspace"
$defualtSecurityContact = "fgarofalo@limitlessdata.ai"
$Policy = Get-AzPolicySetDefinition | where { $_.DisplayName -EQ 'Microsoft cloud security benchmark' }
$securtyTypeName = Get-AzSecurityPricing | Select-Object -Property Name
$UserAssignedIdentity = Get-AzUserAssignedIdentity -ResourceGroupName 'rg-alz-dev-logging' -Name 'alz-umi-identity'
foreach ($i in $mg) {
    Write-Output "Enable Defender for Cloud on management group: $i.Name"
    $sub = Get-AzManagementGroupSubscription -GroupName $i.Name
    foreach ($s in $sub) {
        Write-Output "Enable Defender for Cloud on subscription: $s.Name"
        Set-AzContext -SubscriptionId $s.Id
        Register-AzResourceProvider -ProviderNamespace 'Microsoft.Security'
        Register-AzProviderFeature -FeatureName "MultiCloudPreview" -ProviderNamespace 'Microsoft.Security'
        Register-AzProviderFeature -FeatureName "AttackPaths" -ProviderNamespace 'Microsoft.Security'
        Register-AzProviderFeature -FeatureName "Governance" -ProviderNamespace 'Microsoft.Security'
        Register-AzResourceProvider -ProviderNamespace 'Microsoft.SecurityDevOps'
        Register-AzProviderFeature -FeatureName "DefenderForCloud" -ProviderNamespace 'Microsoft.SecurityDevOps'
        Register-AzResourceProvider -ProviderNamespace 'Microsoft.PolicyInsights'
        Register-AzResourceProvider -ProviderNamespace 'Microsoft.HardwareSecurityModules'
        Register-AzResourceProvider -ProviderNamespace 'Microsoft.SecurityCopilot'
        Register-AzResourceProvider -ProviderNamespace 'Microsoft.OperationalInsights'
        foreach ($t in $securtyTypeName) {
            Write-Output "Enable Defender for Cloud on subscription: $s.Name for $t.Name" 
            if ($t.Name -like "*API*") { Set-AzSecurityPricing -Name $t.Name -PricingTier 'Standard' -SubPlan 'P1' } 
            else { Set-AzSecurityPricing -Name $t.Name -PricingTier 'Standard' }
        }
        Set-AzSecurityContact -Name "default" -Email $defualtSecurityContact -AlertAdmin -NotifyOnAlert
        Set-AzSecurityWorkspaceSetting -Name "default" -Scope "/subscriptions/$defaulWorkspaceSub" -WorkspaceId "/subscriptions/$defaulWorkspaceSub/resourceGroups/$defaulWorkspaceRG/providers/Microsoft.OperationalInsights/workspaces/$defaulWorkspaceName" 
        New-AzPolicyAssignment -Name 'Microsoft cloud security benchmark' -PolicySetDefinition $Policy -Scope "/subscriptions/$($s.Id)" -Location "East US" -IdentityType 'UserAssigned' -IdentityId $UserAssignedIdentity.Id
        Write-Output "Defender for Cloud enabled on subscription: $s.Name"
    }
    Write-Output "Defender for Cloud enabled on management group: $i.Name"
}


# Test Bicep Deployment 
#https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-7.4

Test-AzDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -Debug 

Get-AzDeploymentWhatIfResult -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -ResultFormat "FullResourcePayloads"

New-AzSubscriptionDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -Debug


# Deploy to US Gov Cloud
# CD into the directory where the Bicep file is located
# Set the location and parameters for the deployment
Test-AzDeployment -Location "usgovvirginia" -TemplateFile "main.bicep" -TemplateParameterFile "params.USGov.dev.json" -Debug 

Get-AzDeploymentWhatIfResult -Location "usgovvirginia" -TemplateFile "main.bicep" -TemplateParameterFile "params.USGov.dev.json" -ResultFormat "FullResourcePayloads" 

New-AzSubscriptionDeployment -Location "usgovvirginia" -TemplateFile "main.bicep" -TemplateParameterFile "params.USGov.dev.json" -Debug 



# Deploy Spoke Networks

Test-AzDeployment -Location "East US" -TemplateFile "main.bicep" -TemplateParameterFile "params.spokenetwork.dev.json" -Debug 

Get-AzDeploymentWhatIfResult -Location "East US" -TemplateFile "main.bicep" -TemplateParameterFile "params.spokenetwork.dev.json" -ResultFormat "FullResourcePayloads"


# Full Deployment
New-AzSubscriptionDeployment -Location "eastus" -TemplateFile "main.bicep" -TemplateParameterFile "params.dev.json" -Debug

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

Get-AzOperationalInsightsIntelligencePacks -ResourceGroupName $resourceGroup -WorkspaceName $workspaceName

Get-AzMonitorLogAnalyticsSolution

# Azure CLI 

az monitor log-analytics solution list 