# Install the Az.CosmosDB module if not already installed
Install-Module -Name Az.CosmosDB -AllowClobber -Scope CurrentUser

# Import the module
Import-Module -Name Az.CosmosDB

# Login to Azure
Connect-AzAccount

# Variables
$resourceGroupName = "<YourResourceGroupName>"
$cosmosDbAccountName = "<YourCosmosDBAccountName>"
$synapseWorkspaceName = "<YourSynapseWorkspaceName>"
$synapseResourceGroupName = "<YourSynapseResourceGroupName>"

# Enable Synapse Link for the Cosmos DB account
Set-AzCosmosDBAccount -ResourceGroupName $resourceGroupName `
    -AccountName $cosmosDbAccountName `
    -EnableAnalyticalStorage $true

Write-Output "Synapse Link enabled for Cosmos DB account: $cosmosDbAccountName"

# Connect Cosmos DB to Synapse Workspace
# Install the Az.Synapse module if not already installed
Install-Module -Name Az.Synapse -AllowClobber -Scope CurrentUser

# Import the module
Import-Module -Name Az.Synapse

# Create a linked service in Synapse for Cosmos DB
New-AzSynapseLinkedService -ResourceGroupName $synapseResourceGroupName `
    -WorkspaceName $synapseWorkspaceName `
    -Name "CosmosDBLinkedService" `
    -Type "AzureCosmosDb" `
    -ConnectionString "AccountEndpoint=https://$cosmosDbAccountName.documents.azure.com:443/;AccountKey=<YourCosmosDBAccountKey>;"

Write-Output "Linked service created in Synapse for Cosmos DB"