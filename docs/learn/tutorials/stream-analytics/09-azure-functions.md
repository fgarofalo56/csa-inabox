# ⚡ Tutorial 9: Azure Functions Integration

![Tutorial](https://img.shields.io/badge/Tutorial-09_Functions_Integration-blue)
![Duration](https://img.shields.io/badge/Duration-35_minutes-green)
![Level](https://img.shields.io/badge/Level-Advanced-orange)

__Extend Stream Analytics with Azure Functions for custom processing, external API calls, and automated responses. Trigger serverless functions from streaming events.__

## 🎯 Learning Objectives

- ✅ __Create Azure Functions__ triggered by Stream Analytics
- ✅ __Send alerts via email/SMS__ using custom logic
- ✅ __Call external APIs__ for data enrichment
- ✅ __Implement complex business logic__ beyond SAQL
- ✅ __Handle errors and retries__ in functions

## ⏱️ Time Estimate: 35 minutes

## 📋 Prerequisites

- [x] Completed [Tutorial 08: Power BI Integration](08-powerbi-integration.md)
- [x] Azure Functions Core Tools installed
- [x] Python 3.8+ or Node.js 18+

## 🔧 Step 1: Create Azure Function App

### __1.1 Create Function App__

```powershell
# Create Function App
$functionAppName = "streamfunc$(Get-Random -Minimum 1000 -Maximum 9999)"
$storageAccountFunc = "funcsa$(Get-Random -Minimum 1000 -Maximum 9999)"

# Create storage for function app
az storage account create `
    --name $storageAccountFunc `
    --resource-group $env:STREAM_RG `
    --location $env:STREAM_LOCATION `
    --sku Standard_LRS

# Create Function App (Python runtime)
az functionapp create `
    --name $functionAppName `
    --resource-group $env:STREAM_RG `
    --storage-account $storageAccountFunc `
    --consumption-plan-location $env:STREAM_LOCATION `
    --runtime python `
    --runtime-version 3.9 `
    --functions-version 4 `
    --os-type Linux

# Save function app name
[Environment]::SetEnvironmentVariable("STREAM_FUNCTION_APP", $functionAppName, "User")

Write-Host "Function App created: $functionAppName"
```

## 📨 Step 2: Create Alert Function

### __2.1 Initialize Function Project__

```powershell
# Create local function project
mkdir StreamAlertFunctions
cd StreamAlertFunctions

# Initialize Python function app
func init . --python

# Create HTTP-triggered function for Stream Analytics
func new --name ProcessAlert --template "HTTP trigger" --authlevel function
```

### __2.2 Implement Alert Logic__

Edit `ProcessAlert/__init__.py`:

```python
import logging
import json
import os
from datetime import datetime
import azure.functions as func
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail

def main(req: func.HttpRequest) -> func.HttpResponse:
    """
    Process alerts from Stream Analytics and send notifications.
    """
    logging.info('Processing alert from Stream Analytics')

    try:
        # Parse request body
        req_body = req.get_json()

        # Extract alert details
        device_id = req_body.get('deviceId')
        location = req_body.get('location')
        temperature = req_body.get('temperature')
        anomaly_score = req_body.get('anomalyScore', 0)
        alert_level = req_body.get('alertLevel', 'Unknown')
        timestamp = req_body.get('timestamp')

        logging.info(f"Alert received: Device {device_id}, Level: {alert_level}")

        # Determine if notification should be sent
        if alert_level in ['Critical', 'Warning']:
            # Send email notification
            send_email_alert(
                device_id=device_id,
                location=location,
                temperature=temperature,
                anomaly_score=anomaly_score,
                alert_level=alert_level,
                timestamp=timestamp
            )

            # Log to Application Insights
            logging.warning(
                f"ALERT: {alert_level} - Device {device_id} at {location} - "
                f"Temp: {temperature}°F, Score: {anomaly_score}"
            )

            # Could also:
            # - Send SMS via Twilio
            # - Create ServiceNow ticket
            # - Post to Teams/Slack
            # - Trigger automation workflow

        return func.HttpResponse(
            json.dumps({
                "status": "success",
                "message": f"Alert processed for device {device_id}",
                "notificationSent": alert_level in ['Critical', 'Warning']
            }),
            status_code=200,
            mimetype="application/json"
        )

    except ValueError as ve:
        logging.error(f"Invalid request body: {str(ve)}")
        return func.HttpResponse(
            json.dumps({"status": "error", "message": "Invalid request format"}),
            status_code=400,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error processing alert: {str(e)}")
        return func.HttpResponse(
            json.dumps({"status": "error", "message": str(e)}),
            status_code=500,
            mimetype="application/json"
        )


def send_email_alert(device_id, location, temperature, anomaly_score, alert_level, timestamp):
    """Send email alert using SendGrid."""
    sendgrid_api_key = os.environ.get('SENDGRID_API_KEY')

    if not sendgrid_api_key:
        logging.warning("SendGrid API key not configured, skipping email")
        return

    try:
        message = Mail(
            from_email='alerts@your-domain.com',
            to_emails='operations@your-domain.com',
            subject=f'[{alert_level}] Sensor Alert: {device_id}',
            html_content=f"""
            <html>
            <body>
                <h2 style="color: {'red' if alert_level == 'Critical' else 'orange'}">
                    {alert_level} Alert Detected
                </h2>
                <p><strong>Device ID:</strong> {device_id}</p>
                <p><strong>Location:</strong> {location}</p>
                <p><strong>Temperature:</strong> {temperature}°F</p>
                <p><strong>Anomaly Score:</strong> {anomaly_score:.2f}</p>
                <p><strong>Timestamp:</strong> {timestamp}</p>
                <p><strong>Severity:</strong> {alert_level}</p>
                <hr>
                <p><em>This is an automated alert from Stream Analytics monitoring system.</em></p>
            </body>
            </html>
            """
        )

        sg = SendGridAPIClient(sendgrid_api_key)
        response = sg.send(message)

        logging.info(f"Email sent successfully: {response.status_code}")

    except Exception as e:
        logging.error(f"Failed to send email: {str(e)}")
```

### __2.3 Add Dependencies__

Edit `requirements.txt`:

```text
azure-functions
sendgrid>=6.9.7
requests>=2.28.0
```

### __2.4 Deploy Function__

```powershell
# Deploy to Azure
func azure functionapp publish $env:STREAM_FUNCTION_APP

# Configure app settings
az functionapp config appsettings set `
    --name $env:STREAM_FUNCTION_APP `
    --resource-group $env:STREAM_RG `
    --settings "SENDGRID_API_KEY=your-sendgrid-api-key"

# Get function URL
$functionUrl = az functionapp function show `
    --name $env:STREAM_FUNCTION_APP `
    --resource-group $env:STREAM_RG `
    --function-name ProcessAlert `
    --query "invokeUrlTemplate" `
    --output tsv

Write-Host "Function URL: $functionUrl"
```

## 🔗 Step 3: Configure Function Output in Stream Analytics

### __3.1 Create Function Output__

```powershell
# Create Azure Function output configuration
$functionOutputConfig = @{
    properties = @{
        datasource = @{
            type = "Microsoft.AzureFunction"
            properties = @{
                functionAppName = $env:STREAM_FUNCTION_APP
                functionName = "ProcessAlert"
                apiKey = "YOUR_FUNCTION_KEY"
            }
        }
    }
} | ConvertTo-Json -Depth 10 | Out-File -FilePath "function-output.json" -Encoding UTF8

# Add output to Stream Analytics job
az stream-analytics output create `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --name "FunctionOutput" `
    --properties @function-output.json
```

### __3.2 Update Query to Call Function__

```sql
-- Send critical anomalies to Azure Function
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
    tempAnomaly.Score AS anomalyScore,
    CASE
        WHEN tempAnomaly.Score > 0.8 THEN 'Critical'
        WHEN tempAnomaly.Score > 0.5 THEN 'Warning'
        ELSE 'Info'
    END AS alertLevel
INTO
    FunctionOutput
FROM
    AnomalyDetection
WHERE
    tempAnomaly.IsAnomaly = 1
    AND tempAnomaly.Score > 0.5;  -- Only send significant anomalies
```

## 🌐 Step 4: Create External API Integration Function

### __4.1 Weather API Enrichment Function__

```python
# File: EnrichWithWeather/__init__.py

import logging
import json
import os
import requests
import azure.functions as func

def main(req: func.HttpRequest) -> func.HttpResponse:
    """
    Enrich sensor data with external weather data.
    """
    logging.info('Enriching data with weather information')

    try:
        req_body = req.get_json()
        location = req_body.get('location')
        temperature = req_body.get('temperature')

        # Call external weather API
        weather_api_key = os.environ.get('WEATHER_API_KEY')
        weather_data = get_weather_data(location, weather_api_key)

        # Calculate correlation
        if weather_data:
            indoor_temp = float(temperature)
            outdoor_temp = weather_data.get('temperature', 0)
            temp_differential = indoor_temp - outdoor_temp

            enriched_data = {
                **req_body,
                'outdoorTemperature': outdoor_temp,
                'temperatureDifferential': temp_differential,
                'weatherCondition': weather_data.get('condition', 'Unknown'),
                'humidity_outdoor': weather_data.get('humidity', 0)
            }
        else:
            enriched_data = {**req_body, 'weatherDataAvailable': False}

        return func.HttpResponse(
            json.dumps(enriched_data),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error enriching data: {str(e)}")
        return func.HttpResponse(
            json.dumps({"status": "error", "message": str(e)}),
            status_code=500,
            mimetype="application/json"
        )


def get_weather_data(location: str, api_key: str) -> dict:
    """Fetch weather data from external API."""
    if not api_key:
        return None

    try:
        # Extract city from location string
        city = location.split('/')[0] if '/' in location else location

        # Call weather API (example using OpenWeatherMap)
        url = f"https://api.openweathermap.org/data/2.5/weather"
        params = {
            'q': city,
            'appid': api_key,
            'units': 'imperial'
        }

        response = requests.get(url, params=params, timeout=5)
        response.raise_for_status()

        data = response.json()
        return {
            'temperature': data['main']['temp'],
            'humidity': data['main']['humidity'],
            'condition': data['weather'][0]['description']
        }

    except Exception as e:
        logging.error(f"Failed to fetch weather data: {str(e)}")
        return None
```

## 🔄 Step 5: Create Automation Function

### __5.1 Device Control Function__

```python
# File: DeviceControl/__init__.py

import logging
import json
import azure.functions as func
from azure.iot.hub import IoTHubRegistryManager
from azure.iot.hub.models import CloudToDeviceMethod

def main(req: func.HttpRequest) -> func.HttpResponse:
    """
    Send control commands to devices based on anomalies.
    """
    logging.info('Processing device control request')

    try:
        req_body = req.get_json()
        device_id = req_body.get('deviceId')
        alert_level = req_body.get('alertLevel')
        temperature = req_body.get('temperature')

        # Determine action based on alert level
        action = determine_action(alert_level, temperature)

        if action:
            # Send command to IoT device
            result = send_device_command(device_id, action)

            logging.info(f"Command sent to {device_id}: {action}")

            return func.HttpResponse(
                json.dumps({
                    "status": "success",
                    "device": device_id,
                    "action": action,
                    "result": result
                }),
                status_code=200,
                mimetype="application/json"
            )
        else:
            return func.HttpResponse(
                json.dumps({
                    "status": "no_action",
                    "message": "No action required"
                }),
                status_code=200,
                mimetype="application/json"
            )

    except Exception as e:
        logging.error(f"Error in device control: {str(e)}")
        return func.HttpResponse(
            json.dumps({"status": "error", "message": str(e)}),
            status_code=500,
            mimetype="application/json"
        )


def determine_action(alert_level: str, temperature: float) -> str:
    """Determine appropriate action based on alert."""
    if alert_level == 'Critical' and temperature > 90:
        return "EMERGENCY_SHUTDOWN"
    elif alert_level == 'Critical':
        return "REDUCE_LOAD"
    elif alert_level == 'Warning':
        return "INCREASE_COOLING"
    return None


def send_device_command(device_id: str, command: str) -> dict:
    """Send command to IoT device via IoT Hub."""
    connection_string = os.environ.get('IOT_HUB_CONNECTION_STRING')

    if not connection_string:
        logging.warning("IoT Hub connection string not configured")
        return {"status": "not_configured"}

    try:
        registry_manager = IoTHubRegistryManager(connection_string)

        # Create device method
        method = CloudToDeviceMethod(
            method_name="executeCommand",
            payload={"command": command},
            response_timeout_in_seconds=30,
            connect_timeout_in_seconds=30
        )

        # Invoke method on device
        result = registry_manager.invoke_device_method(device_id, method)

        return {
            "status": "success",
            "response": result.payload
        }

    except Exception as e:
        logging.error(f"Failed to send device command: {str(e)}")
        return {"status": "error", "error": str(e)}
```

## 🧪 Step 6: Testing and Monitoring

### __6.1 Test Function Locally__

```powershell
# Start function locally
func start

# Test with curl
curl -X POST http://localhost:7071/api/ProcessAlert `
  -H "Content-Type: application/json" `
  -d '{
    "deviceId": "sensor-001",
    "location": "Building-A/Floor-1",
    "temperature": 92.5,
    "anomalyScore": 0.85,
    "alertLevel": "Critical",
    "timestamp": "2025-01-15T10:30:00Z"
  }'
```

### __6.2 Monitor Function Executions__

```powershell
# View function logs
az functionapp log tail `
    --name $env:STREAM_FUNCTION_APP `
    --resource-group $env:STREAM_RG

# Check Application Insights
az monitor app-insights metrics show `
    --app $env:STREAM_FUNCTION_APP `
    --resource-group $env:STREAM_RG `
    --metrics "requests/count"
```

## 🎓 Key Concepts Learned

### __Integration Patterns__

- __Alerting__: Send notifications for critical events
- __Enrichment__: Add external data to streams
- __Automation__: Trigger actions based on analytics
- __Orchestration__: Coordinate complex workflows

### __Best Practices__

- Use appropriate timeout settings (30-60 seconds)
- Implement retry logic for transient failures
- Log all function invocations
- Monitor function performance and costs
- Secure function keys in Key Vault

## 🚀 Next Steps

You've integrated serverless functions! Continue to:

__[Tutorial 10: Performance Tuning →](10-performance-tuning.md)__

## 📚 Additional Resources

- [Azure Functions Documentation](https://docs.microsoft.com/azure/azure-functions/)
- [Stream Analytics Azure Functions Output](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-define-outputs#azure-functions)
- [SendGrid Email Integration](https://docs.sendgrid.com/for-developers/sending-email/api-getting-started)

---

__Tutorial Progress:__ 9 of 11 complete | __Next:__ [Performance Tuning](10-performance-tuning.md)

*Last Updated: January 2025*
