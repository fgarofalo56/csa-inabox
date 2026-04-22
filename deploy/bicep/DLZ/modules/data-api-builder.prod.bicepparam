using './data-api-builder.bicep'

param environment = 'prod'
param namePrefix = 'csa-dab'
param sqlAdminLogin = 'sqladmin'
param sqlAdminPassword = '<REPLACE_WITH_KEYVAULT_REFERENCE>'
param sqlSkuName = 'S2'
param staticWebAppSku = 'Standard'
param publicNetworkAccessEnabled = false
param enableResourceLock = true
param containerCpu = '1.0'
param containerMemory = '2Gi'
