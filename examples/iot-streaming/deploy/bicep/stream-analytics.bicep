// ─────────────────────────────────────────────────────────────
// Stream Analytics Job for IoT Telemetry Processing
// CSA-in-a-Box IoT Streaming Example
// ─────────────────────────────────────────────────────────────

@description('Base name for all resources')
param baseName string = 'csaiot'

@description('Azure region for deployment')
param location string = resourceGroup().location

@description('Stream Analytics SKU')
@allowed(['Standard'])
param asaSku string = 'Standard'

@description('Streaming Units (1, 3, 6, 12, 18, 24, 30, 36, 42, 48)')
@allowed([1, 3, 6, 12, 18, 24, 30, 36, 42, 48])
param streamingUnits int = 6

@description('Event Hub namespace name (from iot-hub.bicep output)')
param eventHubNamespaceName string

@description('Event Hub name for telemetry input')
param telemetryHubName string = 'telemetry'

@description('Event Hub consumer group for ASA')
param consumerGroupName string = 'asa-consumer'

@description('Event Hub namespace connection string (Listen policy)')
param eventHubConnectionString string

@description('ADLS Gen2 storage account name for raw output')
param adlsAccountName string

@description('ADLS Gen2 account key')
@secure()
param adlsAccountKey string

@description('ADX cluster URI (e.g., https://csaadx.eastus.kusto.windows.net)')
param adxClusterUri string = ''

@description('ADX database name')
param adxDatabaseName string = 'realtime'

@description('Log Analytics workspace resource ID for diagnostics')
param logAnalyticsWorkspaceId string

@description('Tags to apply to all resources')
param tags object = {
  Project: 'CSA-in-a-Box'
  Component: 'IoT-Streaming'
  Environment: 'dev'
}

// ─── Variables ────────────────────────────────────────────────
var jobName = '${baseName}-asa'
var adlsContainerRaw = 'bronze'
var adlsContainerProcessed = 'silver'

// ─── Stream Analytics Job ────────────────────────────────────
resource streamAnalyticsJob 'Microsoft.StreamAnalytics/streamingjobs@2021-10-01-preview' = {
  name: jobName
  location: location
  tags: tags
  properties: {
    sku: {
      name: asaSku
    }
    eventsOutOfOrderPolicy: 'Adjust'
    outputErrorPolicy: 'Stop'
    eventsOutOfOrderMaxDelayInSeconds: 5
    eventsLateArrivalMaxDelayInSeconds: 16
    dataLocale: 'en-US'
    compatibilityLevel: '1.2'
    contentStoragePolicy: 'SystemAccount'
    jobType: 'Cloud'
    transformation: {
      name: 'TelemetryTransformation'
      properties: {
        streamingUnits: streamingUnits
        query: '''
          -- ═══════════════════════════════════════════════════════════
          -- Transformation: Parse and enrich raw IoT telemetry
          -- ═══════════════════════════════════════════════════════════

          -- Pass-through to raw storage (cold path)
          SELECT
              sensor_id,
              sensor_type,
              CAST(timestamp AS datetime) AS event_time,
              temperature_c,
              humidity_pct,
              pressure_hpa,
              battery_pct,
              latitude,
              longitude,
              System.Timestamp() AS processing_time,
              EventProcessedUtcTime AS ingestion_time
          INTO [RawOutput]
          FROM [TelemetryInput]
          TIMESTAMP BY CAST(timestamp AS datetime);

          -- 5-minute tumbling window aggregation for dashboards
          SELECT
              sensor_id,
              sensor_type,
              System.Timestamp() AS window_end,
              AVG(temperature_c) AS avg_temperature,
              MIN(temperature_c) AS min_temperature,
              MAX(temperature_c) AS max_temperature,
              AVG(humidity_pct) AS avg_humidity,
              AVG(pressure_hpa) AS avg_pressure,
              COUNT(*) AS reading_count,
              MIN(battery_pct) AS min_battery
          INTO [ADXOutput]
          FROM [TelemetryInput]
          TIMESTAMP BY CAST(timestamp AS datetime)
          GROUP BY
              sensor_id,
              sensor_type,
              TumblingWindow(minute, 5);

          -- Anomaly detection on temperature readings
          SELECT
              sensor_id,
              CAST(timestamp AS datetime) AS event_time,
              temperature_c,
              AnomalyDetection_SpikeAndDip(
                  CAST(temperature_c AS float), 95, 120, 'spikesanddips'
              ) OVER (
                  PARTITION BY sensor_id
                  LIMIT DURATION(minute, 120)
              ) AS anomaly_score
          INTO [AlertOutput]
          FROM [TelemetryInput]
          TIMESTAMP BY CAST(timestamp AS datetime)
          WHERE sensor_type = 'temperature';
        '''
      }
    }
  }
}

// ─── Input: Event Hub Telemetry ──────────────────────────────
resource telemetryInput 'Microsoft.StreamAnalytics/streamingjobs/inputs@2021-10-01-preview' = {
  parent: streamAnalyticsJob
  name: 'TelemetryInput'
  properties: {
    type: 'Stream'
    datasource: {
      type: 'Microsoft.ServiceBus/EventHub'
      properties: {
        serviceBusNamespace: eventHubNamespaceName
        sharedAccessPolicyName: 'ListenRule'
        sharedAccessPolicyKey: listKeys(resourceId('Microsoft.EventHub/namespaces/eventhubs/authorizationRules', eventHubNamespaceName, telemetryHubName, 'ListenRule'), '2024-01-01').primaryKey
        eventHubName: telemetryHubName
        consumerGroupName: consumerGroupName
        authenticationMode: 'ConnectionString'
      }
    }
    serialization: {
      type: 'Json'
      properties: {
        encoding: 'UTF8'
      }
    }
  }
}

// ─── Output: ADLS Gen2 Raw (Cold Path) ──────────────────────
resource rawOutput 'Microsoft.StreamAnalytics/streamingjobs/outputs@2021-10-01-preview' = {
  parent: streamAnalyticsJob
  name: 'RawOutput'
  properties: {
    datasource: {
      type: 'Microsoft.Storage/Blob'
      properties: {
        storageAccounts: [
          {
            accountName: adlsAccountName
            accountKey: adlsAccountKey
          }
        ]
        container: adlsContainerRaw
        pathPattern: 'iot-streaming/telemetry/{date}/{time}'
        dateFormat: 'yyyy/MM/dd'
        timeFormat: 'HH'
        authenticationMode: 'ConnectionString'
      }
    }
    serialization: {
      type: 'Parquet'
    }
  }
}

// ─── Output: ADLS Gen2 Processed (Warm Path) ────────────────
resource processedOutput 'Microsoft.StreamAnalytics/streamingjobs/outputs@2021-10-01-preview' = {
  parent: streamAnalyticsJob
  name: 'ADXOutput'
  properties: {
    datasource: {
      type: 'Microsoft.Storage/Blob'
      properties: {
        storageAccounts: [
          {
            accountName: adlsAccountName
            accountKey: adlsAccountKey
          }
        ]
        container: adlsContainerProcessed
        pathPattern: 'iot-streaming/aggregated/{date}/{time}'
        dateFormat: 'yyyy/MM/dd'
        timeFormat: 'HH'
        authenticationMode: 'ConnectionString'
      }
    }
    serialization: {
      type: 'Parquet'
    }
  }
}

// ─── Output: Alert Output ────────────────────────────────────
resource alertOutput 'Microsoft.StreamAnalytics/streamingjobs/outputs@2021-10-01-preview' = {
  parent: streamAnalyticsJob
  name: 'AlertOutput'
  properties: {
    datasource: {
      type: 'Microsoft.Storage/Blob'
      properties: {
        storageAccounts: [
          {
            accountName: adlsAccountName
            accountKey: adlsAccountKey
          }
        ]
        container: adlsContainerProcessed
        pathPattern: 'iot-streaming/alerts/{date}/{time}'
        dateFormat: 'yyyy/MM/dd'
        timeFormat: 'HH'
        authenticationMode: 'ConnectionString'
      }
    }
    serialization: {
      type: 'Json'
      properties: {
        encoding: 'UTF8'
        format: 'LineSeparated'
      }
    }
  }
}

// ─── Diagnostic Settings ─────────────────────────────────────
resource asaDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: '${jobName}-diag'
  scope: streamAnalyticsJob
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'Execution', enabled: true }
      { category: 'Authoring', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// ─── Outputs ─────────────────────────────────────────────────
output jobName string = streamAnalyticsJob.name
output jobId string = streamAnalyticsJob.id
