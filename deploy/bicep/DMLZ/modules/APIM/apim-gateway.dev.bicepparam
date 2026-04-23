using './apim-gateway.bicep'

// ─── Dev Environment Parameters ─────────────────────────────────────────────
// Developer SKU with relaxed rate limits for testing and development.

param namePrefix = 'csa-datamesh'
param environment = 'dev'
param publisherEmail = 'dev-team@contoso.com'
param publisherName = 'CSA-in-a-Box Dev'
param apimSku = 'Developer'
param skuCount = 1
param enableAppInsights = true
param publicNetworkAccessEnabled = true

// Backend URLs — update these after deploying backend services
param dabBackendUrl = 'https://dab-dev.internal.contoso.com'
param aiBackendUrl = 'https://portal-dev.internal.contoso.com/api/v1/ai'
param marketplaceBackendUrl = 'https://portal-dev.internal.contoso.com/api/v1/marketplace'
param portalBackendUrl = 'https://portal-dev.internal.contoso.com/api/v1'

// JWT — configure after Azure AD app registration
param jwtIssuer = 'https://login.microsoftonline.us/{tenant-id}/v2.0'
param jwtAudience = 'api://csa-datamesh-dev'

// Relaxed rate limits for development
param rateLimitCalls = 500
param rateLimitPeriod = 60
param allowedOrigins = '*'

// No resource locks in dev
param enableResourceLock = false
