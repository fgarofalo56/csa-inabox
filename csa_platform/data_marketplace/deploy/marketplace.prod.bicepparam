using 'marketplace.bicep'

param environment = 'prod'
param baseName = 'csa-marketplace'
param appServicePlanSku = 'P1v3'
param cosmosConsistencyLevel = 'Session'
param cosmosFreeTier = false
param apimPublisherEmail = 'platform-team@contoso.com'
param apimPublisherName = 'CSA-in-a-Box'
param apimSku = 'Standard'
param enableResourceLock = true
param publicNetworkAccessEnabled = false
