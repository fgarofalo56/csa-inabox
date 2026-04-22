using './data-api-builder.bicep'

param environment = 'dev'
param namePrefix = 'csa-dab'
param sqlAdminLogin = 'sqladmin'
param sqlAdminPassword = '<REPLACE_WITH_SECURE_PASSWORD>'
param sqlSkuName = 'Basic'
param staticWebAppSku = 'Free'
param publicNetworkAccessEnabled = true
param enableResourceLock = false
param containerCpu = '0.25'
param containerMemory = '0.5Gi'
