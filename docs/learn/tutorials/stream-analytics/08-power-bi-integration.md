# 📊 Tutorial 8: Power BI Integration

![Tutorial](https://img.shields.io/badge/Tutorial-08_Power_BI_Integration-blue)
![Duration](https://img.shields.io/badge/Duration-30_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Create real-time dashboards with Power BI streaming datasets. Visualize live sensor data, anomalies, and KPIs with automatic refresh and interactive reports.__

## 🎯 Learning Objectives

- ✅ __Configure Power BI output__ in Stream Analytics
- ✅ __Create streaming datasets__ for real-time data
- ✅ __Build live dashboards__ with tiles and visuals
- ✅ __Implement auto-refresh__ capabilities
- ✅ __Design KPI monitors__ and alert visuals

## ⏱️ Time Estimate: 30 minutes

## 📋 Prerequisites

- [x] Completed [Tutorial 07: Anomaly Detection](07-anomaly-detection.md)
- [x] Power BI account (free or Pro)
- [x] Power BI workspace access

## 🔌 Step 1: Configure Power BI Output

### __1.1 Authorize Power BI Connection__

```powershell
# Authorize Stream Analytics to Power BI (opens browser)
Write-Host "Opening browser to authorize Power BI connection..."
$authUrl = "https://login.microsoftonline.com/common/oauth2/authorize?client_id=1950a258-227b-4e31-a9cf-717495945fc2&response_type=code&redirect_uri=https://portal.azure.com&response_mode=query&resource=https://analysis.windows.net/powerbi/api"
Start-Process $authUrl
```

### __1.2 Create Power BI Output__

```powershell
# Create Power BI output configuration
$powerbiConfig = @"
{
  "properties": {
    "datasource": {
      "type": "PowerBI",
      "properties": {
        "dataset": "StreamAnalyticsSensorData",
        "table": "RealTimeTelemetry",
        "groupId": "",
        "groupName": "My Workspace",
        "refreshToken": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
"@

# Note: Easier to configure via Azure Portal
# Portal > Stream Analytics Job > Outputs > Add Power BI
Write-Host "Configure Power BI output through Azure Portal for easier authentication"
```

## 📈 Step 2: Create Streaming Query for Power BI

### __2.1 Real-Time Metrics Query__

```sql
-- Real-time sensor metrics for Power BI
SELECT
    deviceId,
    location,
    SUBSTRING(location, 1, CHARINDEX('/', location) - 1) AS building,
    System.Timestamp() AS timestamp,
    AVG(temperature) AS avgTemperature,
    MIN(temperature) AS minTemperature,
    MAX(temperature) AS maxTemperature,
    AVG(humidity) AS avgHumidity,
    AVG(vibration) AS avgVibration,
    COUNT(*) AS eventCount,
    SUM(CASE WHEN status = 'critical' THEN 1 ELSE 0 END) AS criticalCount,
    SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) AS warningCount,
    SUM(CASE WHEN status = 'normal' THEN 1 ELSE 0 END) AS normalCount
INTO
    PowerBIOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    deviceId,
    location,
    SUBSTRING(location, 1, CHARINDEX('/', location) - 1),
    TumblingWindow(second, 10);
```

### __2.2 Anomaly Detection for Visualization__

```sql
-- Anomaly detection results for Power BI alerts
WITH AnomalyDetection AS (
    SELECT
        deviceId,
        location,
        timestamp,
        temperature,
        vibration,
        status,
        CAST(AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikesanddips')
            OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD) AS tempAnomaly
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    vibration,
    status,
    tempAnomaly.IsAnomaly AS isAnomaly,
    tempAnomaly.Score AS anomalyScore,
    CASE
        WHEN tempAnomaly.IsAnomaly = 1 AND tempAnomaly.Score > 0.8 THEN 'Critical'
        WHEN tempAnomaly.IsAnomaly = 1 THEN 'Warning'
        ELSE 'Normal'
    END AS alertLevel
INTO
    PowerBIOutput
FROM
    AnomalyDetection
WHERE
    tempAnomaly.IsAnomaly = 1;
```

### __2.3 KPI Summary Query__

```sql
-- High-level KPIs for executive dashboard
SELECT
    System.Timestamp() AS timestamp,
    COUNT(DISTINCT deviceId) AS activeDevices,
    COUNT(*) AS totalEvents,
    AVG(temperature) AS avgTemperature,
    MAX(temperature) AS maxTemperature,
    SUM(CASE WHEN status = 'critical' THEN 1 ELSE 0 END) AS criticalDevices,
    SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) AS warningDevices,
    CAST(SUM(CASE WHEN status = 'normal' THEN 1 ELSE 0 END) AS FLOAT) /
        CAST(COUNT(*) AS FLOAT) * 100 AS healthPercentage
INTO
    PowerBIOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    TumblingWindow(minute, 1);
```

## 🎨 Step 3: Build Power BI Dashboard

### __3.1 Create Streaming Dataset__

After Stream Analytics starts sending data:

1. Navigate to [Power BI](https://powerbi.microsoft.com)
2. Select workspace (My Workspace or team workspace)
3. Dataset should auto-create from Stream Analytics output
4. Verify data is flowing: Datasets → StreamAnalyticsSensorData → View data

### __3.2 Create Real-Time Dashboard__

Create a new dashboard with these tiles:

__Tile 1: Active Devices Count__
```
Visualization: Card
Field: activeDevices (Max)
Title: "Active Sensors"
```

__Tile 2: Average Temperature__
```
Visualization: Gauge
Field: avgTemperature
Minimum: 60
Maximum: 100
Title: "Current Avg Temperature"
```

__Tile 3: Temperature Trend__
```
Visualization: Line Chart
Axis: timestamp
Values: avgTemperature
Title: "Temperature Over Time (Last Hour)"
```

__Tile 4: Devices by Status__
```
Visualization: Donut Chart
Legend: status
Values: Count of deviceId
Title: "Device Health Status"
```

__Tile 5: Critical Alerts__
```
Visualization: Card
Field: criticalCount (Sum)
Format: Conditional (Red if > 0)
Title: "Critical Alerts"
```

### __3.3 Create Detail Report__

Build a detailed report page:

```
Page Layout:
┌─────────────────────────────────────────┐
│  KPI Cards Row                          │
│  [Active] [Avg Temp] [Alerts] [Health%]│
├─────────────────────────────────────────┤
│  Temperature Trend (Line Chart)         │
│                                         │
├──────────────────┬──────────────────────┤
│ Device Status    │  Anomaly Alerts      │
│ (Donut Chart)    │  (Table)             │
├──────────────────┴──────────────────────┤
│ Device Details (Table with drill-down) │
└─────────────────────────────────────────┘
```

## 📊 Step 4: Advanced Visualizations

### __4.1 Heat Map Query__

```sql
-- Building heat map data
SELECT
    SUBSTRING(location, 1, CHARINDEX('/', location) - 1) AS building,
    DATEPART(hour, System.Timestamp()) AS hour,
    AVG(temperature) AS avgTemp,
    System.Timestamp() AS timestamp
INTO
    PowerBIOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
GROUP BY
    SUBSTRING(location, 1, CHARINDEX('/', location) - 1),
    DATEPART(hour, System.Timestamp()),
    TumblingWindow(hour, 1);
```

__Power BI Visual:__ Matrix with conditional formatting

### __4.2 Anomaly Timeline__

```sql
-- Anomaly events timeline
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    'Temperature Spike' AS anomalyType,
    CAST(AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikes')
        OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD).Score AS severity
INTO
    PowerBIOutput
FROM
    EventHubInput TIMESTAMP BY timestamp
WHERE
    CAST(AnomalyDetection_SpikeAndDip(temperature, 95, 120, 'spikes')
        OVER(PARTITION BY deviceId LIMIT DURATION(minute, 15)) AS RECORD).IsAnomaly = 1;
```

__Power BI Visual:__ Scatter chart (timestamp x temperature, sized by severity)

### __4.3 Device Health Score__

```sql
-- Device health score calculation
WITH HealthMetrics AS (
    SELECT
        deviceId,
        location,
        AVG(temperature) AS avgTemp,
        STDEV(temperature) AS tempVariability,
        AVG(vibration) AS avgVibration,
        COUNT(*) AS eventCount,
        System.Timestamp() AS timestamp
    FROM
        EventHubInput TIMESTAMP BY timestamp
    GROUP BY
        deviceId,
        location,
        TumblingWindow(minute, 5)
)
SELECT
    deviceId,
    location,
    timestamp,
    avgTemp,
    tempVariability,
    avgVibration,
    -- Health score (0-100)
    CASE
        WHEN avgVibration < 0.5 AND avgTemp BETWEEN 68 AND 75 AND tempVariability < 2 THEN 100
        WHEN avgVibration < 1.0 AND avgTemp BETWEEN 65 AND 80 AND tempVariability < 5 THEN 75
        WHEN avgVibration < 1.5 AND avgTemp BETWEEN 60 AND 85 THEN 50
        ELSE 25
    END AS healthScore,
    CASE
        WHEN avgVibration < 0.5 AND avgTemp BETWEEN 68 AND 75 AND tempVariability < 2 THEN 'Excellent'
        WHEN avgVibration < 1.0 AND avgTemp BETWEEN 65 AND 80 AND tempVariability < 5 THEN 'Good'
        WHEN avgVibration < 1.5 AND avgTemp BETWEEN 60 AND 85 THEN 'Fair'
        ELSE 'Poor'
    END AS healthGrade
INTO
    PowerBIOutput
FROM
    HealthMetrics;
```

__Power BI Visual:__ KPI indicator with trends

## ⚡ Step 5: Real-Time Features

### __5.1 Auto-Refresh Configuration__

Power BI streaming datasets auto-refresh, but for reports:

1. Open report in edit mode
2. View ribbon → Page view → Select page
3. Page settings → Page refresh → Set to 1 second
4. Publish report

### __5.2 Mobile Dashboard Layout__

Create mobile-optimized view:

1. Dashboard → Edit → Mobile layout
2. Rearrange tiles for vertical layout
3. Prioritize: KPIs → Alerts → Charts
4. Save mobile view

### __5.3 Email Alerts from Power BI__

Configure data alerts:

1. Dashboard tile → More options (...)
2. Manage alerts
3. Add alert rule:
   - Threshold: criticalCount > 0
   - Check frequency: Every hour
   - Email: your-email@domain.com

## 📱 Step 6: Advanced Dashboard Features

### __6.1 Q&A Natural Language__

Enable Q&A on dashboard:

```
Example questions:
- "Show average temperature by building"
- "Which devices have critical status?"
- "Temperature trend for last hour"
- "Count of anomalies by device"
```

### __6.2 Drill-Through Pages__

Create drill-through from device tile to details:

1. Create detail page
2. Add drill-through field: deviceId
3. Add visuals: temperature history, anomaly list, status timeline
4. Users can right-click device → Drill through

### __6.3 Bookmarks and Buttons__

Create navigation:

```
Bookmarks:
- Overview (default view)
- Anomalies (filtered to anomalies only)
- Critical Devices (status = critical)
- Building A Focus
- Building B Focus
```

## ✅ Validation and Testing

### __Test Dashboard Responsiveness__

```powershell
# Generate burst of data to test real-time updates
python multi_device_simulator.py --duration 300 --rate 5
```

Watch Power BI dashboard update in real-time.

### __Performance Optimization__

1. __Dataset Optimization:__
   - Limit to last 24 hours of data
   - Pre-aggregate in Stream Analytics
   - Use appropriate data types

2. __Visual Optimization:__
   - Limit visuals per page (< 10)
   - Use appropriate chart types
   - Enable visual interactions selectively

## 🎓 Key Concepts Learned

### __Streaming vs. Push Datasets__

| Feature | Streaming Dataset | Push Dataset |
|---------|------------------|--------------|
| __Data Retention__ | 1 hour | Configurable |
| __Refresh__ | Real-time | On-demand |
| __Query Capability__ | Limited | Full |
| __Best For__ | Live monitoring | Recent history |

### __Best Practices__

- Aggregate data before sending to Power BI
- Use tumbling windows (10-60 seconds) for updates
- Limit columns to needed fields only
- Pre-calculate metrics in Stream Analytics
- Use Power BI Pro for sharing dashboards

## 🚀 Next Steps

You've created real-time dashboards! Continue to:

__[Tutorial 09: Azure Functions Integration →](09-functions-integration.md)__

## 📚 Additional Resources

- [Power BI Streaming Datasets](https://docs.microsoft.com/power-bi/connect-data/service-real-time-streaming)
- [Stream Analytics Power BI Output](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-power-bi-dashboard)
- [Power BI Dashboard Best Practices](https://docs.microsoft.com/power-bi/create-reports/service-dashboards-design-tips)

---

__Tutorial Progress:__ 8 of 11 complete | __Next:__ [Azure Functions Integration](09-functions-integration.md)

*Last Updated: January 2025*
