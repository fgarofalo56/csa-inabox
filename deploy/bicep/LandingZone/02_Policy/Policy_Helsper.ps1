
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
Get-AzPolicySetDefinition -Builtin | Where-Object DisplayName -Like 'Enable allLogs category group resource logging*'

Get-AzPolicySetDefinition -Name 'f5b29bc4-feca-4cc6-a58a-772dd5e290a5'

az role definition list --name 'Contributor' --query [].name


$subscriptionId = (Get-AzContext).Subscription.Id



Get-AzDiagnosticSetting -ResourceId "/subscriptions/$subscriptionId/resourceGroups/rg-alz-dev-logging/providers/Microsoft.OperationalInsights/workspaces/alz-dev-log-analytics"
Get-AzDiagnosticSettingCategory -ResourceId "/subscriptions/$subscriptionId/resourceGroups/rg-alz-dev-logging/providers/Microsoft.OperationalInsights/workspaces/alz-dev-log-analytics"