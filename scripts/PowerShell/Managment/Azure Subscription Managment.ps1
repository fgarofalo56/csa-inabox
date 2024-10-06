Connect-AzAccount

# View Capacity of Azure Subscription by us regions
#List all US Regions
Get-AzLocation | Where-Object { $_.GeographyGroup -eq "US" } | Select-Object DisplayName, Location, PairedRegion, PhysicalLocation, Longitude, Latitudev | Format-Table -AutoSize



# View Capacity of Azure Subscription by us regions (Check each region manually using the Azure Portal or Azure OpenAI Studio)
$regions = Get-AzLocation | Where-Object { $_.GeographyGroup -eq "US" } | Select-Object DisplayName, Location
foreach ($region in $regions) {
    Write-Output "Region: $($region.DisplayName), Location: $($region.Location)"
    # Manually check the quota details for this region in the Azure Portal or Azure OpenAI Studio
}




# Get an Azure AD token
$tokenResponse = Get-AzAccessToken -ResourceUrl "https://management.azure.com"
$accessToken = $tokenResponse.Token

# Set params
$subscriptionId = Get-AzSubscription | Where-Object Name -Like '*frgarofa*' | Select-Object -ExpandProperty Id
$region = "eastus"
$providerID = "Microsoft.MachineLearningServices"

# Use the token to fetch quota information
$apiUrl = "https://management.azure.com/subscriptions/$subscriptionId/providers/Microsoft.Capacity/resourceProviders/$providerID/locations/$region/serviceLimits?api-version=2020-10-25"
$headers = @{
    "Authorization" = "Bearer $accessToken"
}
$response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get
# $response.value
$response.value | Select-Object Name, Type, @{Name = 'ObjectName'; Expression = { $_.Name } } `
    , @{Name = "currentValue"; Expression = { $_.properties.currentValue } } `
    , @{Name = "Limit"; Expression = { $_.properties.limit } } `
    , @{Name = "ResourceType"; Expression = { $_.properties.resourceType } } `
    , @{Name = "Unit"; Expression = { $_.properties.unit } } `
    , @{Name = "ServiceLimitName"; Expression = { $_.properties.name.value } } `
    , @{Name = "localizedValue"; Expression = { $_.properties.name.localizedValue } } `
| Format-Table -AutoSize


#List Opertions for api-version
# Set params
$apiPath = "operations"
$api = "2022-11-01"
# Use the token to fetch quota information
$apiUrl = "https://management.azure.com/providers/Microsoft.Capacity/${$apiPath}?api-version=$api"
$headers = @{
    "Authorization" = "Bearer $accessToken"
}
$response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get
$response.value


#List Opertions by providerId (CognitiveServices)
# https://management.azure.com/providers/Microsoft.CognitiveServices/operations?api-version=2023-05-01

$providerID = "Microsoft.CognitiveServices"
$apiUrl = "https://management.azure.com/providers/$providerID/operations?api-version=2023-05-01"
$headers = @{
    "Authorization" = "Bearer $accessToken"
}
$response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get
$response.value


# Get List of Resource providers
# Define the subscription ID and API version
$subscriptionId = Get-AzSubscription | Where-Object Name -Like '*frgarofa*' | Select-Object -ExpandProperty Id
$apiVersion = "2021-04-01"

# Define the API endpoint
$apiUrl = "https://management.azure.com/subscriptions/$subscriptionId/providers?api-version=$apiVersion"
# Make the API call
$headers = @{
    "Authorization" = "Bearer $accessToken"
}
$response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get
$response.value | Where-Object registrationState -EQ "Registered" | Select-Object namespace | Sort-Object namespace
$cogServ = $response.value | Where-Object namespace -EQ "Microsoft.CognitiveServices"
$cogServ.resourceTypes | Select-Object resourceType, locations, apiVersions, defaultApiVersion, capabilities | Format-Table -AutoSize



#Get List of skus

$subscriptionId = Get-AzSubscription | Where-Object Name -Like '*frgarofa*' | Select-Object -ExpandProperty Id
$providerID = "Microsoft.CognitiveServices"
# GET https://management.azure.com/subscriptions/{subscriptionId}/providers/Microsoft.CognitiveServices/skus?api-version=2023-05-01
$apiUrl = "https://management.azure.com/subscriptions/$subscriptionId/providers/$providerID/skus?api-version=2023-05-01"
$headers = @{
    "Authorization" = "Bearer $accessToken"
}
$response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get
$response.value | Where-Object kind -Like "*open*"


#Check Sku Availability
# Set params
$subscriptionId = Get-AzSubscription | Where-Object Name -Like '*frgarofa*' | Select-Object -ExpandProperty Id
$providerID = "Microsoft.CognitiveServices"
$region = "eastus"
$body = @{
    skus = @("S0")
    kind = "OpenAI"
    type = "Microsoft.CognitiveServices/accounts"
}
#Convert to JSON
$jsonBody = $body | ConvertTo-Json
#         POST https://management.azure.com/subscriptions/{subscriptionId}/providers/Microsoft.CognitiveServices/locations/{location}/checkSkuAvailability?api-version=2023-05-01
$apiUrl = "https://management.azure.com/subscriptions/$subscriptionId/providers/$providerID/locations/$region/checkSkuAvailability?api-version=2023-05-01"
$headers = @{
    "Authorization" = "Bearer $accessToken"
    "Content-Type"  = "application/json"
}
$response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Body $jsonBody -Method Post
$response.value



#Defender information
#GET https://management.azure.com/ { scopeId }/providers/Microsoft.Security/pricings/ { pricingName }?api-version=2024-01-01
# Get an Azure AD token
$tokenResponse = Get-AzAccessToken -ResourceUrl "https://management.azure.com"
$accessToken = $tokenResponse.Token

$subscriptionId = Get-AzSubscription | Where-Object Name -Like '*frgarofa*' | Select-Object -ExpandProperty Id
$apiUrl = "https://management.azure.com/subscriptions/$subscriptionId/providers/Microsoft.Security/pricings?api-version=2024-01-01"
$headers = @{
    "Authorization" = "Bearer $accessToken"
}
$response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get
$response.value | Select-Object Name, @{Name = "PricingTier"; Expression = { $_.properties.pricingTier } }, @{Name = "SubPlan"; Expression = { $_.properties.SubPlan } }, @{Name = "deprecated"; Expression = { $_.properties.deprecated } } | Format-Table -AutoSize

$response.value | Where-Object name -EQ "CloudPosture" | Select-Object -ExpandProperty properties | Select-Object -ExpandProperty extensions