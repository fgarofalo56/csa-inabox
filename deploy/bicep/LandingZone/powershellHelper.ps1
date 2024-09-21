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

New-AzSubscriptionDeployment -Location "East US" -TemplateFile ".\deploy\bicep\LandingZone\main.bicep" -TemplateParameterFile ".\deploy\bicep\LandingZone\params.spokenetwork.dev.json" -Debug

Get-AzSubscriptionDeployment | Remove-AzSubscriptionDeployment

Get-AzSubscriptionDeployment -Id '076322ff-5d31-4133-8776-0e9ca79019ff' | Format-List

