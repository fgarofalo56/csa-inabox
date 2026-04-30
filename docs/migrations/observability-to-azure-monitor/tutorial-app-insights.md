# Tutorial: Instrument an Application with Application Insights

**Time:** 60-90 minutes
**Prerequisites:** Azure subscription, .NET 8+ or Java 17+ application, Azure CLI
**Last updated:** 2026-04-30

---

## What you will build

In this tutorial, you will:

1. Create an Application Insights resource backed by a Log Analytics workspace
2. Instrument a .NET or Java application with Application Insights (auto-instrumentation + OpenTelemetry)
3. Configure adaptive sampling to control telemetry volume
4. Set up availability tests (synthetic monitoring)
5. Create metric and log-based alert rules
6. Explore the Application Map, performance views, and failure analysis

By the end, you will have a fully instrumented application sending traces, metrics, exceptions, and dependency data to Application Insights -- replacing the APM functionality of Datadog, New Relic, or Splunk Observability.

---

## Step 1: Create infrastructure

### Create the Log Analytics workspace and Application Insights resource

```bash
# Variables
RESOURCE_GROUP="rg-observability-tutorial"
LOCATION="eastus"
WORKSPACE_NAME="law-observability-tutorial"
APP_INSIGHTS_NAME="ai-myapp-tutorial"

# Create resource group
az group create --name $RESOURCE_GROUP --location $LOCATION

# Create Log Analytics workspace
az monitor log-analytics workspace create \
  --resource-group $RESOURCE_GROUP \
  --workspace-name $WORKSPACE_NAME \
  --retention-in-days 90

# Get workspace resource ID
WORKSPACE_ID=$(az monitor log-analytics workspace show \
  --resource-group $RESOURCE_GROUP \
  --workspace-name $WORKSPACE_NAME \
  --query id -o tsv)

# Create workspace-based Application Insights
az monitor app-insights component create \
  --app $APP_INSIGHTS_NAME \
  --location $LOCATION \
  --resource-group $RESOURCE_GROUP \
  --workspace $WORKSPACE_ID \
  --kind web

# Get the connection string
CONNECTION_STRING=$(az monitor app-insights component show \
  --app $APP_INSIGHTS_NAME \
  --resource-group $RESOURCE_GROUP \
  --query connectionString -o tsv)

echo "Connection String: $CONNECTION_STRING"
```

!!! note "Workspace-based vs Classic"
Always create workspace-based Application Insights resources. Classic (standalone) resources are deprecated and do not support the full feature set, including cross-workspace queries and unified log retention policies.

---

## Step 2: Instrument your application

Choose your language track below.

### Track A: .NET application (ASP.NET Core)

#### Add the Azure Monitor OpenTelemetry package

```bash
dotnet add package Azure.Monitor.OpenTelemetry.AspNetCore
```

#### Configure in Program.cs

```csharp
using Azure.Monitor.OpenTelemetry.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

// Add Azure Monitor OpenTelemetry
builder.Services.AddOpenTelemetry().UseAzureMonitor(options =>
{
    // Connection string from environment variable (recommended)
    // Set APPLICATIONINSIGHTS_CONNECTION_STRING in your environment
    // Or configure explicitly:
    // options.ConnectionString = "InstrumentationKey=...";
});

// Add your services
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
app.MapControllers();
app.Run();
```

#### Set the connection string

```bash
# Environment variable (recommended)
export APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=...;IngestionEndpoint=..."

# Or in appsettings.json
# {
#   "AzureMonitor": {
#     "ConnectionString": "InstrumentationKey=..."
#   }
# }
```

#### What gets auto-instrumented

With zero additional code, the SDK captures:

- **Incoming HTTP requests** (ASP.NET Core middleware) -- request URL, status code, duration
- **Outgoing HTTP calls** (HttpClient) -- dependency URL, status code, duration
- **SQL Server queries** (Microsoft.Data.SqlClient) -- query text, duration, success
- **Azure SDK calls** (Azure.Core) -- service, operation, duration
- **Exceptions** -- stack traces, inner exceptions, custom properties
- **ILogger messages** -- log level, message, structured properties

#### Add custom telemetry

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;

public class OrderController : ControllerBase
{
    // Custom ActivitySource for manual spans
    private static readonly ActivitySource ActivitySource = new("MyApp.Orders");

    // Custom Meter for business metrics
    private static readonly Meter Meter = new("MyApp.OrderMetrics");
    private static readonly Counter<long> OrderCounter = Meter.CreateCounter<long>("orders_created");
    private static readonly Histogram<double> OrderValueHistogram =
        Meter.CreateHistogram<double>("order_value_dollars");

    [HttpPost]
    public async Task<IActionResult> CreateOrder(OrderRequest request)
    {
        // Custom span (trace)
        using var activity = ActivitySource.StartActivity("ProcessOrder");
        activity?.SetTag("order.type", request.Type);
        activity?.SetTag("order.region", request.Region);

        try
        {
            var order = await _orderService.CreateAsync(request);

            // Custom metrics
            OrderCounter.Add(1,
                new KeyValuePair<string, object?>("type", request.Type),
                new KeyValuePair<string, object?>("region", request.Region));
            OrderValueHistogram.Record(order.TotalAmount);

            return Ok(order);
        }
        catch (Exception ex)
        {
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            throw;
        }
    }
}
```

#### Enable the Profiler

Add the Profiler for production CPU analysis (replaces Datadog Continuous Profiler):

```csharp
builder.Services.AddOpenTelemetry().UseAzureMonitor();
builder.Services.AddServiceProfiler(); // Requires Microsoft.ApplicationInsights.Profiler.AspNetCore
```

#### Enable Snapshot Debugger

```csharp
builder.Services.AddSnapshotCollector(config =>
{
    config.IsEnabledInDeveloperMode = false;
    config.ThresholdForSnapshotting = 1;
    config.MaximumSnapshotsRequired = 3;
    config.MaximumCollectionPlanSize = 50;
});
```

### Track B: Java application (Spring Boot)

#### Download the Application Insights Java agent

```bash
# Download the latest agent
curl -L -o applicationinsights-agent.jar \
  "https://github.com/microsoft/ApplicationInsights-Java/releases/latest/download/applicationinsights-agent.jar"
```

#### Create the configuration file

Create `applicationinsights.json` in the same directory as the agent JAR:

```json
{
    "connectionString": "${APPLICATIONINSIGHTS_CONNECTION_STRING}",
    "role": {
        "name": "order-service"
    },
    "sampling": {
        "percentage": 50,
        "overrides": [
            {
                "telemetryType": "exception",
                "percentage": 100
            },
            {
                "telemetryType": "dependency",
                "attributes": [
                    {
                        "key": "http.url",
                        "value": "https://login.microsoftonline.com/.*",
                        "matchType": "regexp"
                    }
                ],
                "percentage": 0
            }
        ]
    },
    "instrumentation": {
        "logging": {
            "level": "WARN"
        },
        "micrometer": {
            "enabled": true
        }
    },
    "preview": {
        "profiler": {
            "enabled": true
        }
    }
}
```

#### Run the application with the agent

```bash
export APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=..."

java -javaagent:applicationinsights-agent.jar \
  -jar my-spring-boot-app.jar
```

#### Docker configuration

```dockerfile
FROM eclipse-temurin:17-jre
WORKDIR /app
COPY applicationinsights-agent.jar .
COPY applicationinsights.json .
COPY my-spring-boot-app.jar .
ENV APPLICATIONINSIGHTS_CONNECTION_STRING=""
ENTRYPOINT ["java", "-javaagent:applicationinsights-agent.jar", "-jar", "my-spring-boot-app.jar"]
```

#### Kubernetes deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
    name: order-service
spec:
    template:
        spec:
            containers:
                - name: order-service
                  image: myregistry.azurecr.io/order-service:latest
                  env:
                      - name: APPLICATIONINSIGHTS_CONNECTION_STRING
                        valueFrom:
                            secretKeyRef:
                                name: app-insights-secret
                                key: connection-string
                      - name: JAVA_TOOL_OPTIONS
                        value: "-javaagent:/app/applicationinsights-agent.jar"
```

---

## Step 3: Configure sampling

Sampling controls telemetry volume and cost. Without sampling, a high-traffic application can generate significant ingestion costs.

### Recommended sampling configuration

| Environment               | Sampling rate      | Rationale                                       |
| ------------------------- | ------------------ | ----------------------------------------------- |
| Development               | 100% (no sampling) | Full visibility for debugging                   |
| Staging                   | 50%                | Balance between visibility and volume           |
| Production (low traffic)  | 50-100%            | Enough volume to sample meaningfully            |
| Production (high traffic) | 10-25%             | Cost control; statistically accurate aggregates |

### Sampling overrides (keep 100% for critical telemetry)

```json
{
    "sampling": {
        "percentage": 25,
        "overrides": [
            {
                "telemetryType": "exception",
                "percentage": 100
            },
            {
                "telemetryType": "request",
                "attributes": [
                    {
                        "key": "http.status_code",
                        "value": "5.*",
                        "matchType": "regexp"
                    }
                ],
                "percentage": 100
            }
        ]
    }
}
```

This configuration samples 25% of normal traffic but keeps 100% of exceptions and 5xx errors.

---

## Step 4: Set up availability tests

Availability tests replace Datadog Synthetics, New Relic Synthetics, and Splunk Synthetics.

### URL ping test (free)

```bash
az monitor app-insights web-test create \
  --resource-group $RESOURCE_GROUP \
  --name "Homepage Availability" \
  --defined-web-test-name "homepage-ping" \
  --location $LOCATION \
  --web-test-kind "ping" \
  --synthetic-monitor-id "homepage-ping" \
  --frequency 300 \
  --timeout 120 \
  --locations Id="us-fl-mia-edge" \
  --locations Id="us-ca-sjc-azr" \
  --locations Id="emea-nl-ams-azr" \
  --locations Id="apac-sg-sin-azr" \
  --locations Id="emea-gb-db3-azr" \
  --tags "hidden-link:${APP_INSIGHTS_ID}=Resource" \
  --content-validation content-match="Welcome" \
  --enabled true \
  --ssl-check true \
  --ssl-lifetime-check 7 \
  --expected-status-code 200 \
  --request-url "https://myapp.azurewebsites.net/"
```

### Standard test (multi-step validation)

For complex scenarios (login flows, API sequences), use the TrackAvailability API:

```csharp
public class AvailabilityTestService : BackgroundService
{
    private readonly TelemetryClient _telemetryClient;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var availability = new AvailabilityTelemetry
            {
                Name = "Order API Health Check",
                RunLocation = "custom-azure-vm",
                Success = false
            };

            var stopwatch = Stopwatch.StartNew();
            try
            {
                using var client = new HttpClient();
                var response = await client.GetAsync("https://api.myapp.com/health");
                response.EnsureSuccessStatusCode();

                var body = await response.Content.ReadAsStringAsync();
                var health = JsonSerializer.Deserialize<HealthResponse>(body);

                availability.Success = health?.Status == "Healthy";
                availability.Message = $"Status: {health?.Status}";
            }
            catch (Exception ex)
            {
                availability.Message = ex.Message;
            }
            finally
            {
                stopwatch.Stop();
                availability.Duration = stopwatch.Elapsed;
                _telemetryClient.TrackAvailability(availability);
            }

            await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
        }
    }
}
```

---

## Step 5: Create alert rules

### Alert 1: High error rate

```bash
az monitor scheduled-query create \
  --name "High Error Rate" \
  --resource-group $RESOURCE_GROUP \
  --scopes $WORKSPACE_ID \
  --condition "count > 10" \
  --condition-query "AppRequests | where TimeGenerated > ago(5m) | where ResultCode startswith '5' | summarize ErrorCount = count() by AppRoleName" \
  --severity 1 \
  --evaluation-frequency 5m \
  --window-size 5m \
  --action-groups $ACTION_GROUP_ID
```

### Alert 2: Slow response time (P95 > 2 seconds)

```bash
az monitor metrics alert create \
  --name "Slow Response Time" \
  --resource-group $RESOURCE_GROUP \
  --scopes $APP_INSIGHTS_ID \
  --condition "avg requests/duration > 2000" \
  --window-size 5m \
  --evaluation-frequency 1m \
  --severity 2 \
  --action $ACTION_GROUP_ID
```

### Alert 3: Availability test failure

```bash
az monitor metrics alert create \
  --name "Availability Test Failed" \
  --resource-group $RESOURCE_GROUP \
  --scopes $APP_INSIGHTS_ID \
  --condition "count availabilityResults/availabilityPercentage < 100" \
  --window-size 5m \
  --evaluation-frequency 1m \
  --severity 1 \
  --action $ACTION_GROUP_ID
```

---

## Step 6: Explore Application Insights features

### Application Map

Navigate to Application Insights > Application Map in the Azure portal. You will see:

- All discovered services and their dependencies
- Request rate, error rate, and average duration between nodes
- Click any node to drill into its performance details

### Performance view

Navigate to Application Insights > Performance:

- **Operations tab:** Request duration percentiles by endpoint
- **Dependencies tab:** External call duration and failure rates
- **Roles tab:** Compare performance across service instances

### Failure analysis

Navigate to Application Insights > Failures:

- **Operations tab:** Failed requests by endpoint
- **Dependencies tab:** Failed external calls
- **Exceptions tab:** Exception types with drill-down to stack traces
- **Samples:** Individual failed request traces with full end-to-end detail

### Live Metrics

Navigate to Application Insights > Live Metrics:

- Real-time request rate, failure rate, and dependency call rate
- Sub-second latency (no aggregation delay)
- Live log stream with filtering
- Unique to Application Insights -- no equivalent in Datadog, New Relic, or Splunk

---

## Verification checklist

After completing this tutorial, verify:

- [ ] Application Insights shows incoming requests in the Performance view
- [ ] Application Map displays your service and its dependencies
- [ ] Custom metrics appear in Metrics Explorer under the custom namespace
- [ ] Exceptions appear in the Failures view with stack traces
- [ ] Availability test results show in the Availability view
- [ ] Alert rules fire correctly (test by triggering a failure)
- [ ] Sampling is active and reducing telemetry volume
- [ ] Live Metrics shows real-time telemetry stream

---

## Next steps

- [Log Migration](log-migration.md) -- configure log ingestion from your infrastructure
- [Alerting Migration](alerting-migration.md) -- migrate remaining alert rules
- [Dashboard Migration](dashboard-migration.md) -- build operational dashboards
- [Best Practices](best-practices.md) -- optimize cost and performance

---

**Related:** [APM Migration](apm-migration.md) | [Tutorial: Log Analytics](tutorial-log-analytics.md) | [Feature Mapping](feature-mapping-complete.md)
