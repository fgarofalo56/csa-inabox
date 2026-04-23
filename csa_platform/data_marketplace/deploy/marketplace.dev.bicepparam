using 'marketplace.bicep'

param environment = 'dev'
param baseName = 'csa-marketplace'
param appServicePlanSku = 'B1'
param cosmosConsistencyLevel = 'Session'
param cosmosFreeTier = true
param apimPublisherEmail = 'admin@contoso.com'
param apimPublisherName = 'CSA-in-a-Box Dev'
param apimSku = 'Developer'
param enableResourceLock = false
param publicNetworkAccessEnabled = true
