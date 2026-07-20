// CSA Loom — compute/loom-maps-app.bicep
// OSS self-hosted vector-tile server (tileserver-gl, BSD-2) — the GCC-High /
// sovereign replacement for Azure Maps (which has no Government data-plane).
// Serves a MapLibre GL style.json + vector tiles + glyphs + sprites for every
// Loom map surface, plus the MapLibre GL JS/CSS the browser renderer loads.
// Everything is served from THIS in-VNet container — no atlas.microsoft.com, no
// Fabric / Power BI, no external CDN (no-fabric-dependency.md, sovereign).
//
// Ingress is INTERNAL to the Container Apps Env: the operator's browser is not on
// the VNet, so it never reaches this host directly. The Console fronts it through
// the session-guarded proxy route /api/maps/tiles/* (app/api/maps/tiles), which
// forwards each request here — there is NO public map endpoint (design:
// docs/fiab/gov-replacements/maps-oss.md §3).
//
// Image: a hardened rebuild of `maptiler/tileserver-gl` in the Loom ACR that bakes
// in an OSS OpenMapTiles (ODbL — OpenStreetMap) US extract MBTiles + the OpenMapTiles
// style + glyphs/sprites, AND the maplibre-gl.js / maplibre-gl.css assets (so the
// browser loads the renderer from the same in-VNet origin). The image is built +
// pushed to ACR by the app-deploy workflow like the other OSS side-cars
// (loom-dbt-runner / loom-wrangler-host / loom-unity). Larger / regional extracts
// are an image-build knob; no Fabric, no external map host.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container Apps Environment ID')
param caeId string

@description('ACR login server (image pulled from here for boundary-local availability)')
param acrLoginServer string

@description('tileserver-gl image tag in ACR')
param imageTag string = 'v1'

@description('Runner UAMI resource ID (ACR pull)')
param uamiId string

@description('Runner UAMI client ID (injected as AZURE_CLIENT_ID)')
param uamiClientId string

@description('App Insights connection string')
param appInsightsConnectionString string

@description('Compliance tags')
param complianceTags object

resource mapsTiles 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: 'loom-maps-tiles'
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uamiId}': {}
    }
  }
  properties: {
    managedEnvironmentId: caeId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // VNet-internal only — reached by the Console proxy over the CAE network.
        // No public map endpoint (sovereign): the browser talks to the Console,
        // the Console talks to this host in-VNet.
        external: false
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
        traffic: [
          { latestRevision: true, weight: 100 }
        ]
      }
      registries: [
        {
          server: acrLoginServer
          identity: uamiId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'loom-maps-tiles'
          image: '${acrLoginServer}/loom-maps-tileserver:${imageTag}'
          env: [
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'AZURE_CLIENT_ID', value: uamiClientId }
            // tileserver-gl honours PORT; the image serves on 8080 (matches targetPort).
            { name: 'PORT', value: '8080' }
            { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.name=loom-maps-tiles,csa-loom.app=maps-tileserver' }
          ]
          // Vector-tile serving is CPU-light + cache-friendly; 0.5 vCPU / 1Gi is ample.
          resources: { cpu: json('0.5'), memory: '1Gi' }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 10
              failureThreshold: 3
              initialDelaySeconds: 5
            }
          ]
        }
      ]
      scale: {
        // Scale to zero between map sessions — tiles are immutable + cacheable, so
        // a cold start on first map-open is fine.
        minReplicas: 0
        maxReplicas: 3
        rules: [
          {
            name: 'http-rule'
            http: { metadata: { concurrentRequests: '20' } }
          }
        ]
      }
    }
  }
}

output tileServerAppId string = mapsTiles.id
output tileServerAppName string = mapsTiles.name
// Internal endpoint the Console proxy forwards to; LOOM_MAPS_TILE_URL is this + /style.json.
output tileServerInternalEndpoint string = 'https://${mapsTiles.properties.configuration.ingress.fqdn}'
