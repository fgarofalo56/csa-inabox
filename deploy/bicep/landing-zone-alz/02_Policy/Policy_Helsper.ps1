
Connect-AzAccount

# Export all built-in policies to a CSV file
Get-AzPolicyDefinition |
Where-Object {
    $_.PolicyType -eq 'BuiltIn' -and
    $_.DisplayName -notlike '*Deprecated*' -and $_.DisplayName -notlike '*Event Hub*' -and $_.DisplayName -notlike '*Legacy*' -and
    (
        $_.DisplayName -like '*LA workspace*' -or 
        $_.DisplayName -like '*Log Analytics*' -or 
        $_.Description -like '*Log Analytics*' -or 
        $_.Description -like '*LA workspace*' -or
        $_.Description -like '*diagnostic settings*' -or
        $_.DisplayName -like '*diagnostic settings*'
    )
} | Select-Object -Property Name, DisplayName, Description, PolicyType, Id, Type, PolicyRule, Parameter, Mode, Metadata, @{Name = 'Category'; Expression = { $_.metadata.category } } | Export-Csv -Path 'AzureBuiltInPolicies.csv' -NoTypeInformation


#Export built-in policies sets to a CSV file - compare to list of all built-in policies to which ones are not in a set
$policySets = Get-AzPolicySetDefinition |
Where-Object {
    $_.PolicyType -eq 'BuiltIn' -and
    $_.DisplayName -notlike '*Deprecated*' -and $_.DisplayName -notlike '*Event Hub*' -and $_.DisplayName -notlike '*Legacy*' -and
    (
        $_.DisplayName -like '*LA workspace*' -or 
        $_.DisplayName -like '*Log Analytics*' -or 
        $_.Description -like '*Log Analytics*' -or 
        $_.Description -like '*LA workspace*' -or
        $_.Description -like '*diagnostic settings*' -or
        $_.DisplayName -like '*diagnostic settings*'
    )
} 
$results = $policySets | ForEach-Object {
    $policy = $_
    $_.PolicyDefinition | ForEach-Object {
        [PSCustomObject]@{
            DisplayName                  = $policy.DisplayName
            Id                           = $policy.Id
            Category                     = $policy.Metadata.category
            PolicyDefinitionId           = $_.policyDefinitionId
            ParameterEffectDefaultValue  = $policy.Parameter.Effect.defaultValue
            ParameterEffectAllowedValues = $policy.Parameter.Effect.allowedValues 
            Parameters                   = $policy.Parameter | ForEach-Object { $_ | Get-Member -MemberType Properties }
        }
    }
}
#Export Results to csv
$results | Export-Csv -Path 'AzureBuiltInPoliciesSets.csv' -NoTypeInformation

$results.Parameters | Export-Csv -Path 'Pararms.csv' -NoTypeInformation

# List out PolicySets to add to Bicep temap to deploy
$policySets | Select-Object -Property DisplayName, Description, Id

# List out Parameters 
$policySets.Parameter
$policySets.Parameter | ForEach-Object { $_ | Get-Member -MemberType Properties }






#Deploy policy using Bicep
New-AzSubscriptionDeployment -Location 'East US' -TemplateFile './deploy/bicep/LandingZone/02_Policy/PolicySets/enable_DataObserviablity.bicep' -Debug


New-AzSubscriptionDeployment -Location 'East US' -TemplateFile './deploy/bicep/LandingZone/02_Policy/PolicyAssignmentsa/workspaceRoleAssignment.bicep' -Debug


az monitor log-analytics workspace get-shared-keys --resource-group 'rg-alz-logging-001' --workspace-name 'alz-log-analytics'
az monitor log-analytics workspace show --resource-group 'rg-alz-logging-001' --workspace-name 'alz-log-analytics' 



Get-AzPolicyDefinition | Where-Object Name -Like '*ffb6f416-7bd2-4488-8828-56585fef2be9' | Select-Object -Property Parameter | ConvertTo-Json
Get-AzPolicySetDefinition -Builtin | Where-Object DisplayName -Like '*Evaluate Private Link Usage*'

Get-AzPolicySetDefinition -Name 'f5b29bc4-feca-4cc6-a58a-772dd5e290a5'

az role definition list --name 'Contributor' --query [].name


$subscriptionId = (Get-AzContext).Subscription.Id



Get-AzDiagnosticSetting -ResourceId "/subscriptions/$subscriptionId/resourceGroups/rg-alz-dev-logging/providers/Microsoft.OperationalInsights/workspaces/alz-dev-log-analytics"
Get-AzDiagnosticSettingCategory -ResourceId "/subscriptions/$subscriptionId/resourceGroups/rg-alz-dev-logging/providers/Microsoft.OperationalInsights/workspaces/alz-dev-log-analytics"




Get-AzPolicyRemediation | Where-Object Name -Like 'alz*' | Remove-AzPolicyRemediation

Get-AzPolicyAssignment | Where-Object Name -Like 'alz*' | Remove-AzPolicyAssignment


Get-AzPolicyAssignment | Format-Table


# Pull list of Role definition for assigned policies
# List all policy assignments:
Update-AzConfig -DefaultSubscriptionForLogin 'a0d6cfbe-8dc6-49b2-80da-c2473a463a98'

# Update AzConfig for login 
Update-AzConfig -LoginExperienceV2 On

# Enable Login By Wam: web account manager
Update-AzConfig -EnableLoginByWam $true

Update-AzConfig -EnableDataCollection $False

# Check Config
Get-AzConfig 

Get-AzPolicyAssignment | Select-Object -Property Name, PolicyDefinitionId, Id

$SubscriptionId = (Get-AzSubscription).Id
$policyAssignments = Get-AzPolicyAssignment | Select-Object -Property Name, PolicyDefinitionId, Id

# Get all Policy Definitions for Assignments to Sets
$policySetsDefinitions = @()
foreach ($sets in $policyAssignments) {
    $policySetsDefinitions += Get-AzPolicySetDefinition -Id $sets.PolicyDefinitionId
}

# Get the details of each policy set definition:
$policyDefinitionList = @()
foreach ($PolicyDefinition in $policySetsDefinitions) {
    $policyDefinitionList += $PolicyDefinition.PolicyDefinition | Select-Object policyDefinitionId
}

# Get Policy Definitions
$PolicyDefinition = @()
foreach ($policyDefinitionId in $policyDefinitionList) {
    $PolicyDefinition += Get-AzPolicyDefinition -Id $policyDefinitionId.policyDefinitionId
}


# Get the roleDefinitionIds from the policy definitions:
$roleDefinitionIds = @()
foreach ($policyDefinitionInfo in $PolicyDefinition) {
    $roleDefinitionIds += $policyDefinitionInfo.PolicyRule.then.details.roleDefinitionIds
}

# Display the unique roleDefinitionIds:
$uniqueRoleDefinitionIds = $roleDefinitionIds | Sort-Object -Unique
$uniqueRoleDefinitionIds


## Pull information about Parameters for Policy Definitions Sets


$pdTest = $policySetsDefinitions
# ParamName
$pdTest | ForEach-Object { $_.Parameter | Get-Member -MemberType Properties } | Select-Object -ExpandProperty Name
#Returns same as above
$pdTest | ForEach-Object { $_.Parameter.PSObject.Properties.Name }

# Get the DisplayName of the parameter
$pdTest | ForEach-Object { $_.Parameter.PSObject.Properties.Value.metadata.DisplayName }

# Get the Description of the parameter
$pdTest | ForEach-Object { $_.Parameter.PSObject.Properties.Value.metadata.description }

# Policy Definition Name
$pdTest.DisplayName

# Get the default value for the parameter
$pdTest | ForEach-Object { $_.Parameter.PSObject.Properties.Value } | Select-Object defaultValue

# Get the allowed values for the parameter
$pdTest | ForEach-Object { $_.Parameter.PSObject.Properties.Value } | Select-Object -ExpandProperty allowedValues


#ConvertTo-Json
$pdTest | ForEach-Object { $_.Parameter } | ConvertTo-Json -Depth 4

$params = @()
foreach ($i in $pdTest) {
    $paramObject = [PSCustomObject]@{
        PolicyDisplayName      = $i.DisplayName
        PolicyName             = $i.Name
        PolicyDescription      = $i.Description
        ParameterName          = $i | ForEach-Object { $_.Parameter | Get-Member -MemberType Properties } | Select-Object -ExpandProperty Name
        ParameterDisplayName   = $i | ForEach-Object { $_.Parameter.PSObject.Properties.Value.metadata } | Select-Object DisplayName
        ParameterDiscription   = $i | ForEach-Object { $_.Parameter.PSObject.Properties.Value.metadata } | Select-Object description
        ParameterDefaultValue  = $i | ForEach-Object { $_.Parameter.PSObject.Properties.Value } | Select-Object defaultValue
        ParameterAllowedValues = $i | ForEach-Object { 
            $allowedValues = $_.Parameter.PSObject.Properties.Value.allowedValues
            if ($null -eq $allowedValues) {
                $allowedValues = $null
            }
            $allowedValues
        }
    }
    $params += $paramObject
}

# Flatten the $params array
$flattenedParams1 = @()
foreach ($param in $params | Where-Object { $_.ParameterDefaultValue.Count -gt 1 }) {
    for ($i = 0; $i -lt $param.ParameterName.Count; $i++) {
        $flattenedParams1 += [PSCustomObject]@{
            PolicyDisplayName      = $param.PolicyDisplayName
            PolicyName             = $param.PolicyName
            # PolicyDescription      = $param.PolicyDescription
            ParameterName          = $param.ParameterName[$i]
            ParameterDisplayName   = $param.ParameterDisplayName
            ParameterDescription   = $param.ParameterDescription
            ParameterDefaultValue  = $param.ParameterDefaultValue
            ParameterAllowedValues = $param.ParameterAllowedValues
        }
    }
}

$flattenedParams2 = @()
foreach ($param in $flattenedParams1) {
    for ($i = 0; $i -lt $param.ParameterDefaultValue.Count; $i++) {
        $flattenedParams2 += [PSCustomObject]@{
            PolicyDisplayName      = $param.PolicyDisplayName
            PolicyName             = $param.PolicyName
            # PolicyDescription      = $param.PolicyDescription
            ParameterName          = $param.ParameterName
            ParameterDisplayName   = $param.ParameterDisplayName
            ParameterDescription   = $param.ParameterDescription
            ParameterDefaultValue  = $param.ParameterDefaultValue[$i]
            ParameterAllowedValues = $param.ParameterAllowedValues
        }
    }
}




# Output the flattened table as a CSV file for easy viewing
$path = 'D:\frgarofa\DeskTop\PolicyParameters.csv'
$flattenedParams2 | Export-Csv -Path $path -NoTypeInformation


