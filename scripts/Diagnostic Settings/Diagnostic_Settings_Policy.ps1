# https://learn.microsoft.com/en-us/azure/azure-monitor/essentials/diagnostic-settings-policy

Connect-AzAccount

# Set Default Subscription
Update-AzConfig -DefaultSubscriptionForLogin "Azure Internal Demo Subscription FRGAROFA - FedCiv ATU FFL FedAIRS Commercial Tenant"

# Select Subscription
$subscription = Get-AzSubscription -SubscriptionName "Azure Internal Demo Subscription FRGAROFA - FedCiv ATU FFL FedAIRS Commercial Tenant"
$subscription | Set-AzContext

# Install AzDigPolicy Scritp
Install-Script -Name Create-AzDiagPolicy

# Run AzDigPolicy Script
Create-AzDiagPolicy.ps1 -ExportLA -ExportDir ".\PolicyFiles"

## Pull list of built in policies
Get-AzPolicyDefinition | Where-Object { $_.PolicyType -eq 'BuiltIn' }


# Create a policy definition by using the policy definition file. Loop throulgh all the files in the PolicyFiles directory and use the New-AzPolicyDefinition cmdlet to create a policy definition for each by using the -Name and -PolicyDefinitionFile parameters.

$policyFiles = Get-ChildItem -Path ".\PolicyFiles" -Recurse -Filter "azurepolicy.json" 

# Loop through each policy file from $policyFiles using the last folder name as the policy name and remove the words "Apply, Settings, Microsoft", replace all spaces with underscores, all dashes with underscores, and all periods with underscores, make sure the name does not exceed 64 characters.

foreach ($policyFile in $policyFiles) {
    $policyName = $policyFile.Directory.Name -replace "Settings-", "" -replace "-Microsoft", "" -replace "Diag-", "Diag" -replace "LA", "" -replace "\.", "_"
    if ($policyName.Length -gt 64) {
        $policyName = $policyName.Substring(0, 64)
    }
    New-AzPolicyDefinition -Name $policyName -Policy $policyFile.FullName
}


# If you want to delete a policy definition, you can use the Remove-AzPolicyDefinition cmdlet. The following example deletes all policy definitions where the createdBy field is set to the specified value.
#Delete any policy Definitions where subscriptionID is :  "Azure FFL Internal Subscription FRGAROFA"

$policyDefinitions = Get-AzPolicyDefinition |
Where-Object {
    $_.Properties.Metadata.createdBy -eq '6511e809-27ad-41f2-9f54-2cb35250acc0'
}

#For each policy definition in $policyDefinitions, loop through and write to host the policy definition name and the Definition locations

foreach ($policyDefinition in $policyDefinitions) {
 
    Write-Host "Name: $($policyDefinition.Name)"
    Write-Host "Definition: $($policyDefinition.Properties.PolicyRule)"
    Write-Host " "
    Remove-AzPolicyDefinition -Name $policyDefinition.Name -Force 
}




# Loop through each policyDefinition in $policyDefinitions and create a new object that contains the policyDefinintions array with:  policyDefinitionId, policyDefinitionReferenceId, definitionVersion, parameters: porfileName set to diagsettings, logAnalytics set to the resourceID of the loganalytics Name I provide, azureRegions set to eastus, metricsEnabled set to True, Add all of this and output to a new initative definition file.

$initiativeName = "frgarofaDiagnosticSettingsInitiative"
$logAnaylticsId = "/subscriptions/a0d6cfbe-8dc6-49b2-80da-c2473a463a98/resourceGroups/rg-alz-logging-001/providers/Microsoft.OperationalInsights/workspaces/alz-log-analytics"
$azureRegions = @("eastus", "eastus2", "westus", "centralus", "northcentralus", "southcentralus", "eastus2euap", "westcentralus", "westus2")


$initiativeDefinition = @()
foreach ($policyDefinition in $policyDefinitions) {

    $initiativeDefinition += @(@{
                policyDefinitionId = $policyDefinition.ResourceId
                definitionVersion = "1.*.*"
                parameters = @{
                    profileName = @{value = "diagsettings"}
                    logAnalytics = @{value = $logAnaylticsId}
                    azureRegions = @{value =$azureRegions}
                    metricsEnabled = @{value ="True"}
                    logsEnabled = @{value ="True"}}
                }
                )
            }            

# Output the initiative definition to a file in the Initiatives directory
$initiativeDefinition | ConvertTo-Json -Depth 10 | Out-File -FilePath ".\Initiatives\$initiativeName.json"


# Create a policy initiative definition by using the policy initiative definition file. Use the New-AzPolicySetDefinition cmdlet to create a policy initiative definition by using the -Name and -PolicySetDefinitionFile parameters.

$metadata = @{
    category            = "Monitoring Diagnostic Settings"
    version             = "1.0.0"
    owner               = "frgarofa"
    subscriptionName    =   $subscription.Name
    subscriptionId      =   $subscription.Id
    createdDate         =   (Get-Date).ToString()
    lastUpdated         =   (Get-Date).ToString()
    createdBy           =   "c5352c6b-d2a9-426d-9cd9-1e7c4a1fdd5b"
    updatedBy           =   "c5352c6b-d2a9-426d-9cd9-1e7c4a1fdd5b"
}
$customObject = [PSCustomObject]$metadata
$jsonMetaData = $customObject | ConvertTo-Json

$initiativeInfo = @{
    Name = $initiativeName
    ApiVersion = "2023-04-01"
    Metadata = $jsonMetaData
    PolicyDefinition = ".\Initiatives\$initiativeName.json"
    DisplayName = "FRGAROFALO Diagnostic Settings Initiative"
    Description = "This initiative deploys diagnostic settings to all resources in the subscription and sets them to a centeral Log Analytics Workspace."
}

New-AzPolicySetDefinition @initiativeInfo

# Update the policy initiative definition. Use the Set-AzPolicySetDefinition cmdlet to update the policy initiative definition by using the -Name and -PolicySetDefinitionFile parameters.
Set-AzPolicySetDefinition @initiativeInfo


# Assign the policy initiative definition to a scope. Use the New-AzPolicyAssignment cmdlet to assign the policy initiative definition to a scope by using the -Name, -PolicySetDefinition, and -Scope parameters.

$policySetDefinition = Get-AzPolicySetDefinition -Name $initiativeName

$policyAssignment = @{
    Name = $initiativeName
    PolicySetDefinition = $policySetDefinition
    ApiVersion = "2023-04-01"
    Scope = "/subscriptions/$($subscription.Id)"
    AssignIdentity = $true
    DisplayName = "FRGAROFALO Diagnostic Settings Initiative"
    Description = "This initiative deploys diagnostic settings to all resources in the subscription and sets them to a centeral Log Analytics Workspace."
    EnforcementMode = "Default"
    Metadata = $jsonMetaData
    Location = "eastus"
    Verbose = $true
}

New-AzPolicyAssignment @policyAssignment

# Update the policy assignment. Use the Set-AzPolicyAssignment cmdlet to update the policy assignment by using the -Name, -PolicySetDefinition, and -Scope parameters.

$policyAssignmentUpdate = @{
    Name = $initiativeName
    ApiVersion = "2023-04-01"
    Scope = "/subscriptions/$($subscription.Id)"
    AssignIdentity = $true
    DisplayName = "FRGAROFALO Diagnostic Settings Initiative"
    Description = "This initiative deploys diagnostic settings to all resources in the subscription and sets them to a centeral Log Analytics Workspace."
    EnforcementMode = "Default"
    Metadata = $jsonMetaData
    Location = "eastus"
    Verbose = $true
}
Set-AzPolicyAssignment @policyAssignmentUpdate



# Create a remediation task for each policy from the policy initiative.
# Loop through each policy definition in $policyDefinitions and create a new remediation task for each policy by using the Start-AzPolicyRemediation cmdlet with the -PolicyAssignmentId and -PolicyDefinitionId parameters.

$policySetDefinition = Get-AzPolicySetDefinition -Name $initiativeName | Select-Object -ExpandProperty Properties | Select-Object -ExpandProperty PolicyDefinitions
$policyAssignmentId = (Get-AzPolicyAssignment -Scope "/subscriptions/$($subscription.Id)" -Name $initiativeName).PolicyAssignmentId

foreach ($policyDefinition in $policySetDefinition) {
    $remediationTask = @{
        Name = "remediation_" + $policyDefinition.policyDefinitionId.Split("/")[-1]
        PolicyAssignmentId = $policyAssignmentId
        PolicyDefinitionReferenceId = $policyDefinition.policyDefinitionReferenceId
    }
    Start-AzPolicyRemediation @remediationTask
}


# Start a compliance scan
Start-AzPolicyComplianceScan