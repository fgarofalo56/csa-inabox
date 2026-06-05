// =====================================================================
// CSA Loom — Data API builder (DAB) shared preview runtime
// =====================================================================
// Deploys the official Microsoft Data API builder engine as a Container
// App in the Loom admin-plane environment. The Loom DAB editor
// (lib/editors/data-api-builder-editor.tsx) points its live REST + GraphQL
// testers and "publish" probe at this runtime via LOOM_DAB_PREVIEW_URL.
//
// The DAB engine reads /App/dab-config.json at startup. Container Apps
// can't mount an arbitrary file without a volume, so the canonical config
// is delivered as a base64 secret and materialised by the container's
// start command before the engine boots. An empty `entities` map is a
// valid, healthy DAB config — the runtime serves /health (+ the REST and
// GraphQL roots) immediately, and the editor pushes entity-bearing configs
// at test time. The connection string is a Key Vault / param secret and is
// NEVER baked into the image.
//
// Auth to SQL is via the Console UAMI (Active Directory Managed Identity);
// the target SQL database must have a contained DB user created for that
// UAMI with at least db_datareader (see scripts/csa-loom/grant-dab-sql.sh).
// =====================================================================

@description('Container Apps managed environment resource id.')
param managedEnvironmentId string

@description('Azure region.')
param location string = resourceGroup().location

@description('Console UAMI resource id (DAB authenticates to SQL + KV as this identity).')
param uamiResourceId string

@description('Console UAMI client id (used in the SQL connection string for AAD MI auth).')
param uamiClientId string

@description('DAB engine container image.')
param dabImage string = 'mcr.microsoft.com/azure-databases/data-api-builder:latest'

@description('Fully-qualified SQL server name the preview runtime targets, e.g. dabdemo-dev-sql.database.windows.net.')
param sqlServerFqdn string

@description('SQL database name the preview runtime targets.')
param sqlDatabase string

@description('DAB host mode. "development" exposes the GraphQL banana-cake-pop UI + Swagger; "production" hardens it.')
@allowed([ 'development', 'production' ])
param hostMode string = 'development'

@description('CORS origins allowed to call the preview runtime (the Loom console origin).')
param corsOrigins array = []

// AAD Managed-Identity connection string — no secret material, the UAMI is the principal.
var connectionString = 'Server=tcp:${sqlServerFqdn},1433;Database=${sqlDatabase};Authentication=Active Directory Managed Identity;User Id=${uamiClientId};Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;'

// Minimal, valid, healthy DAB config (empty entities — the editor pushes real entities at test time).
var dabConfig = {
  '$schema': 'https://github.com/Azure/data-api-builder/releases/latest/download/dab.draft.schema.json'
  'data-source': {
    'database-type': 'mssql'
    'connection-string': '@env(\'DATABASE_CONNECTION_STRING\')'
    options: { 'set-session-context': false }
  }
  runtime: {
    rest: { enabled: true, path: '/api' }
    graphql: { enabled: true, path: '/graphql', 'allow-introspection': true }
    host: {
      mode: hostMode
      cors: { origins: corsOrigins, 'allow-credentials': false }
      authentication: { provider: 'StaticWebApps' }
    }
  }
  entities: {}
}

resource dab 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'loom-dab-preview'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${uamiResourceId}': {} }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 5000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        { name: 'dab-conn', value: connectionString }
        { name: 'dab-config-b64', value: base64(string(dabConfig)) }
      ]
    }
    template: {
      // An init container materialises the config onto a shared EmptyDir
      // volume; the main container then runs the DAB image's OWN entrypoint
      // (we set `args` only, never `command`, so the image entrypoint is
      // preserved) and is pointed at the volume-mounted config. This avoids
      // depending on the engine binary's path inside the image.
      initContainers: [
        {
          name: 'config-writer'
          image: 'mcr.microsoft.com/cbl-mariner/busybox:2.0'
          command: [ '/bin/sh', '-c' ]
          args: [ 'echo "$DAB_CONFIG_B64" | base64 -d > /config/dab-config.json && echo wrote /config/dab-config.json' ]
          env: [ { name: 'DAB_CONFIG_B64', secretRef: 'dab-config-b64' } ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          volumeMounts: [ { volumeName: 'dab-config', mountPath: '/config' } ]
        }
      ]
      containers: [
        {
          name: 'dab'
          image: dabImage
          // image entrypoint preserved; only pass the config path as args.
          args: [ '--ConfigFileName', '/config/dab-config.json' ]
          env: [
            { name: 'DATABASE_CONNECTION_STRING', secretRef: 'dab-conn' }
            { name: 'ASPNETCORE_URLS', value: 'http://+:5000' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          volumeMounts: [ { volumeName: 'dab-config', mountPath: '/config' } ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 5000 }, initialDelaySeconds: 20, periodSeconds: 30 }
          ]
        }
      ]
      volumes: [ { name: 'dab-config', storageType: 'EmptyDir' } ]
      scale: { minReplicas: 1, maxReplicas: 2 }
    }
  }
}

@description('Wire this into LOOM_DAB_PREVIEW_URL on the loom-console app.')
output dabPreviewUrl string = 'https://${dab.properties.configuration.ingress.fqdn}'
output dabFqdn string = dab.properties.configuration.ingress.fqdn
