# Log into Azure

Connect-AzAccount

# Set Default Subscription
Get-AzSubscription

Set-AzContext -SubscriptionId ""

# Test Bicep Deployment 
#https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-7.4

Test-AzDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -Debug -Verbose:$false -WarningAction SilentlyContinue -WhatIf

$output = Get-AzDeploymentWhatIfResult -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -ResultFormat "FullResourcePayloads"

$output = New-AzSubscriptionDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.dev.json" -Verbose

# expand each object in the array
$output.Outputs | ConvertTo-Json