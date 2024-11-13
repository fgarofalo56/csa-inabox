# Grant Access to Comosmos DB

Connect-AzAccount

$resoureGroupName = "csa-sandbox-tmp"
$cosmosDBAccountName = "csa-nosql-dev-eastus2"


$parameters = @{
    ResourceGroupName = $resoureGroupName
    AccountName       = $cosmosDBAccountName
}
Get-AzCosmosDBSqlRoleDefinition @parameters
$RoleName = "Cosmos DB Built-in Data Contributor"
$roleDefinitionId = Get-AzCosmosDBSqlRoleDefinition @parameters | Where-Object { $_.RoleName -eq $RoleName } | Select-Object -ExpandProperty Id
$roleDefinitionId


#  Get Cossmos DB Account Id
$cosmosDBAccount = Get-AzCosmosDBAccount -ResourceGroupName $resoureGroupName -Name $cosmosDBAccountName
$cosmosDBAccountId = $cosmosDBAccount.Id


# Get the principalId for System Assigned Identity
$resourceName = "csa-datafactory-dev-westus"
$resourceRescoureGroupName = "csa-sandbox-tmp"
$principalId = (Get-AzResource -ResourceGroupName $resourceRescoureGroupName -ResourceName $resourceName ) | Select-Object -ExpandProperty Identity | Select-Object -ExpandProperty PrincipalId
$principalId

# # Get principalId for user to set for Users
# $principalId = (Get-AzADUser -DisplayName "Frank Garofalo").Id
# Get-AzADUser -DisplayName "Frank Garofalo"

#Grant accesss to the user
$parameters = @{
    ResourceGroupName = $resoureGroupName
    AccountName       = $cosmosDBAccountName
    RoleDefinitionId  = $roleDefinitionId
    PrincipalId       = $principalId
    Scope             = $cosmosDBAccountId
}    
New-AzCosmosDBSqlRoleAssignment @parameters

#List all Role Assignments
$parameters = @{
    ResourceGroupName = $resoureGroupName
    AccountName       = $cosmosDBAccountName
}
Get-AzCosmosDBSqlRoleAssignment @parameters