using './apim-gateway.bicep'

// ─── Production Environment Parameters ──────────────────────────────────────
// Standard SKU with strict rate limits, resource locks, and restricted CORS.

param namePrefix = 'csa-datamesh'
param environment = 'prod'
param publisherEmail = 'platform-team@contoso.com'
param publisherName = 'CSA-in-a-Box'
param apimSku = 'Standard'
param skuCount = 2
param enableAppInsights = true
param publicNetworkAccessEnabled = false

// Backend URLs — update to match production service endpoints
param dabBackendUrl = 'https://dab.internal.contoso.com'
param aiBackendUrl = 'https://portal.internal.contoso.com/api/v1/ai'
param marketplaceBackendUrl = 'https://portal.internal.contoso.com/api/v1/marketplace'
param portalBackendUrl = 'https://portal.internal.contoso.com/api/v1'

// JWT — production Azure AD
param jwtIssuer = 'https://login.microsoftonline.us/{tenant-id}/v2.0'
param jwtAudience = 'api://csa-datamesh-prod'

// Strict rate limits for production
param rateLimitCalls = 60
param rateLimitPeriod = 60
param allowedOrigins = 'https://portal.contoso.com,https://admin.contoso.com'

// Resource locks enabled in production
param enableResourceLock = true
