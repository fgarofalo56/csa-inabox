# Log into Azure
Connect-AzAccount

# Log into Azure US Government Cloud
Connect-AzAccount -Environment AzureUSGovernment


# Set Default Subscription
Get-AzSubscription

# Set-AzContext -SubscriptionId "c36bc643-b071-42f8-8197-4c787fcf5549"


# Test Bicep Deployment 
#https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-7.4

Test-AzDeployment -Location "East US" -TemplateFile "main.bicep" -TemplateParameterFile "params.dev.json" -Debug 

Get-AzDeploymentWhatIfResult -Location "East US" -TemplateFile "main.bicep" -TemplateParameterFile "params.dev.json" -ResultFormat "FullResourcePayloads"

New-AzSubscriptionDeployment -Location "East US 2" -TemplateFile "main.bicep" -TemplateParameterFile "params.dev.json" -Debug


# Deploy to US Gov Cloud
# CD into the directory where the Bicep file is located
# Set the location and parameters for the deployment
Test-AzDeployment -Location "usgovvirginia" -TemplateFile "main.bicep" -TemplateParameterFile "params.USGov.dev.json" -Debug

Get-AzDeploymentWhatIfResult -Location "usgovvirginia" -TemplateFile "main.bicep" -TemplateParameterFile "params.USGov.dev.json" -ResultFormat "FullResourcePayloads" 

New-AzSubscriptionDeployment -Location "usgovvirginia" -TemplateFile "main.bicep" -TemplateParameterFile "params.USGov.dev.json" -Debug 


