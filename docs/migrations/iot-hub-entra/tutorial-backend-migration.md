# Tutorial: Migrate Backend Services from SAS to Entra

**Step-by-step guide for migrating backend services (Azure Functions, Logic Apps, event processors) from SAS connection strings to Entra managed identities.**

> **Duration:** 2-3 hours | **Prerequisites:** Azure CLI, access to backend service code
> **Finding:** CSA-0025 (HIGH, BREAKING) | **Ballot:** AQ-0014 (approved)

---

## Prerequisites

Before starting this tutorial, ensure you have:

- [ ] Azure subscription with Owner or Contributor + User Access Administrator role
- [ ] Azure CLI 2.50+ installed
- [ ] Access to backend service source code (Azure Functions, Logic Apps, etc.)
- [ ] Existing IoT Hub with backend services using SAS connection strings
- [ ] Log Analytics workspace for monitoring

### Environment setup

```bash
# Set environment variables
export RG="rg-iot-streaming"
export IOT_HUB=$(az iot hub list -g "$RG" --query "[0].name" -o tsv)
export IOT_HUB_ID=$(az iot hub show -g "$RG" -n "$IOT_HUB" --query id -o tsv)
export IOT_HUB_HOSTNAME="${IOT_HUB}.azure-devices.net"
export EH_NAMESPACE=$(az eventhubs namespace list -g "$RG" --query "[0].name" -o tsv)
export EH_NAMESPACE_ID=$(az eventhubs namespace show -g "$RG" -n "$EH_NAMESPACE" --query id -o tsv)

echo "IoT Hub: $IOT_HUB ($IOT_HUB_HOSTNAME)"
echo "Event Hub Namespace: $EH_NAMESPACE"
```

---

## Step 1: Inventory services using SAS connection strings

Identify every backend service that currently connects to IoT Hub using SAS keys.

```bash
# Search for SAS connection strings in Key Vault
echo "=== Key Vault Secrets Containing IoT Hub Keys ==="
KV_NAME=$(az keyvault list -g "$RG" --query "[0].name" -o tsv)
az keyvault secret list --vault-name "$KV_NAME" \
  --query "[?contains(name, 'iothub') || contains(name, 'iot-hub') || contains(name, 'IoTHub')].name" \
  -o tsv

# Search for Function Apps with IoT Hub connection strings
echo ""
echo "=== Function Apps with IoT Hub Connection Settings ==="
for FUNC in $(az functionapp list -g "$RG" --query "[].name" -o tsv); do
  SETTINGS=$(az functionapp config appsettings list -g "$RG" -n "$FUNC" \
    --query "[?contains(name, 'IoTHub') || contains(name, 'IOTHUB') || contains(name, 'iot_hub')].name" \
    -o tsv)
  if [ -n "$SETTINGS" ]; then
    echo "  $FUNC:"
    echo "    $SETTINGS"
  fi
done

# Search for Logic Apps with IoT Hub API connections
echo ""
echo "=== Logic Apps API Connections ==="
az resource list -g "$RG" \
  --resource-type "Microsoft.Web/connections" \
  --query "[?contains(name, 'iot') || contains(name, 'IoT')].{name:name, type:type}" \
  -o table

# Search for Web Apps with IoT Hub settings
echo ""
echo "=== Web Apps with IoT Hub Settings ==="
for APP in $(az webapp list -g "$RG" --query "[].name" -o tsv 2>/dev/null); do
  SETTINGS=$(az webapp config appsettings list -g "$RG" -n "$APP" \
    --query "[?contains(name, 'IoTHub') || contains(name, 'IOTHUB')].name" \
    -o tsv 2>/dev/null)
  if [ -n "$SETTINGS" ]; then
    echo "  $APP:"
    echo "    $SETTINGS"
  fi
done
```

Document the inventory:

| Service              | Type           | Setting name               | SAS policy used | Required RBAC role       |
| -------------------- | -------------- | -------------------------- | --------------- | ------------------------ |
| func-iot-processor   | Azure Function | `IOTHUB_CONNECTION_STRING` | iothubowner     | IoT Hub Data Contributor |
| func-iot-monitor     | Azure Function | `IOT_EVENTHUB_CONN`        | service         | Event Hubs Data Receiver |
| logic-device-alerts  | Logic App      | API connection             | iothubowner     | IoT Hub Data Reader      |
| app-device-dashboard | Web App        | `IOTHUB_CONN_STR`          | registryRead    | IoT Hub Data Reader      |

---

## Step 2: Create managed identities

Enable system-assigned managed identity on each service.

```bash
# Enable managed identity on Azure Functions
echo "=== Enabling Managed Identities ==="

# Function App 1: IoT Processor
az functionapp identity assign \
  -g "$RG" -n "func-iot-processor" \
  --query principalId -o tsv
echo "  func-iot-processor: Identity assigned"

# Function App 2: IoT Monitor
az functionapp identity assign \
  -g "$RG" -n "func-iot-monitor" \
  --query principalId -o tsv
echo "  func-iot-monitor: Identity assigned"

# Web App: Device Dashboard
az webapp identity assign \
  -g "$RG" -n "app-device-dashboard" \
  --query principalId -o tsv 2>/dev/null
echo "  app-device-dashboard: Identity assigned"

# Logic App: Device Alerts (Standard)
az logicapp identity assign \
  -g "$RG" -n "logic-device-alerts" \
  --query principalId -o tsv 2>/dev/null
echo "  logic-device-alerts: Identity assigned"

# Collect all principal IDs
echo ""
echo "=== Principal IDs ==="
PROCESSOR_PRINCIPAL=$(az functionapp identity show -g "$RG" -n "func-iot-processor" --query principalId -o tsv)
MONITOR_PRINCIPAL=$(az functionapp identity show -g "$RG" -n "func-iot-monitor" --query principalId -o tsv)
DASHBOARD_PRINCIPAL=$(az webapp identity show -g "$RG" -n "app-device-dashboard" --query principalId -o tsv 2>/dev/null)
ALERTS_PRINCIPAL=$(az logicapp identity show -g "$RG" -n "logic-device-alerts" --query principalId -o tsv 2>/dev/null)

echo "  func-iot-processor: $PROCESSOR_PRINCIPAL"
echo "  func-iot-monitor: $MONITOR_PRINCIPAL"
echo "  app-device-dashboard: $DASHBOARD_PRINCIPAL"
echo "  logic-device-alerts: $ALERTS_PRINCIPAL"
```

**Rollback point:** Managed identity can be removed with `az functionapp identity remove`. No impact on existing SAS-based connections.

---

## Step 3: Assign IoT Hub RBAC roles

Assign the minimum required RBAC role to each managed identity.

```bash
# Role definition IDs
IOT_HUB_DATA_CONTRIBUTOR="4fc6c259-987e-4a07-842e-c321cc9d413f"
IOT_HUB_DATA_READER="b447c946-2db7-41ec-983d-d8bf3b1c77e3"
EVENT_HUBS_DATA_RECEIVER="a638d3c7-ab3a-418d-83e6-5f17a39d4fde"
EVENT_HUBS_DATA_SENDER="2b629674-e913-4c01-ae53-ef4638d8f975"

echo "=== Assigning RBAC Roles ==="

# func-iot-processor -> IoT Hub Data Contributor (full device management)
az role assignment create \
  --assignee "$PROCESSOR_PRINCIPAL" \
  --role "$IOT_HUB_DATA_CONTRIBUTOR" \
  --scope "$IOT_HUB_ID"
echo "  func-iot-processor -> IoT Hub Data Contributor"

# func-iot-monitor -> Event Hubs Data Receiver (read telemetry)
az role assignment create \
  --assignee "$MONITOR_PRINCIPAL" \
  --role "$EVENT_HUBS_DATA_RECEIVER" \
  --scope "$EH_NAMESPACE_ID"
echo "  func-iot-monitor -> Event Hubs Data Receiver"

# app-device-dashboard -> IoT Hub Data Reader (read twins)
if [ -n "$DASHBOARD_PRINCIPAL" ]; then
  az role assignment create \
    --assignee "$DASHBOARD_PRINCIPAL" \
    --role "$IOT_HUB_DATA_READER" \
    --scope "$IOT_HUB_ID"
  echo "  app-device-dashboard -> IoT Hub Data Reader"
fi

# logic-device-alerts -> IoT Hub Data Reader
if [ -n "$ALERTS_PRINCIPAL" ]; then
  az role assignment create \
    --assignee "$ALERTS_PRINCIPAL" \
    --role "$IOT_HUB_DATA_READER" \
    --scope "$IOT_HUB_ID"
  echo "  logic-device-alerts -> IoT Hub Data Reader"
fi

# Wait for RBAC propagation
echo ""
echo "Waiting 60 seconds for RBAC propagation..."
sleep 60
echo "RBAC propagation complete."

# Verify role assignments
echo ""
echo "=== Verify Role Assignments ==="
az role assignment list \
  --scope "$IOT_HUB_ID" \
  --query "[?principalType=='ServicePrincipal'].{principal:principalId, role:roleDefinitionName}" \
  -o table
```

**Rollback point:** Remove RBAC assignments with `az role assignment delete`. No impact on SAS-based connections.

---

## Step 4: Update Azure Functions (code changes)

### IoT Processor Function (Python)

```python
# BEFORE: func-iot-processor/function_app.py
import azure.functions as func
from azure.iot.hub import IoTHubRegistryManager
import os

app = func.FunctionApp()

@app.event_hub_message_trigger(
    arg_name="event",
    event_hub_name="",
    connection="IOTHUB_EVENTHUB_CONNECTION_STRING",
    consumer_group="$Default"
)
def process_telemetry(event: func.EventHubEvent):
    # Process telemetry
    conn_str = os.environ["IOTHUB_CONNECTION_STRING"]
    registry = IoTHubRegistryManager(conn_str)
    twin = registry.get_twin(event.metadata.get("iothub-connection-device-id"))
    # ... process twin data
```

```python
# AFTER: func-iot-processor/function_app.py
import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.iot.hub import IoTHubRegistryManager
import os

app = func.FunctionApp()
credential = DefaultAzureCredential()

@app.event_hub_message_trigger(
    arg_name="event",
    event_hub_name="",
    connection="IoTHubEvents",  # Uses identity-based connection
    consumer_group="$Default"
)
def process_telemetry(event: func.EventHubEvent):
    # Process telemetry using managed identity
    iot_hub_hostname = os.environ["IOTHUB_HOSTNAME"]
    registry = IoTHubRegistryManager.from_token_credential(
        url=f"https://{iot_hub_hostname}",
        token_credential=credential,
    )
    device_id = event.metadata.get("iothub-connection-device-id")
    twin = registry.get_twin(device_id)
    # ... process twin data
```

Update `requirements.txt`:

```
azure-functions
azure-iot-hub
azure-identity    # NEW: Required for managed identity
```

### Update Function App settings

```bash
# Update func-iot-processor settings
az functionapp config appsettings set \
  -g "$RG" -n "func-iot-processor" \
  --settings \
    "IOTHUB_HOSTNAME=$IOT_HUB_HOSTNAME" \
    "IoTHubEvents__fullyQualifiedNamespace=${EH_NAMESPACE}.servicebus.windows.net"

# Remove old SAS connection string settings
az functionapp config appsettings delete \
  -g "$RG" -n "func-iot-processor" \
  --setting-names "IOTHUB_CONNECTION_STRING" "IOTHUB_EVENTHUB_CONNECTION_STRING"

echo "func-iot-processor settings updated."

# Update func-iot-monitor settings
az functionapp config appsettings set \
  -g "$RG" -n "func-iot-monitor" \
  --settings \
    "IoTHubEvents__fullyQualifiedNamespace=${EH_NAMESPACE}.servicebus.windows.net"

az functionapp config appsettings delete \
  -g "$RG" -n "func-iot-monitor" \
  --setting-names "IOT_EVENTHUB_CONN"

echo "func-iot-monitor settings updated."
```

### Deploy updated Functions

```bash
# Deploy updated function code
cd func-iot-processor
func azure functionapp publish func-iot-processor --python
cd ..

cd func-iot-monitor
func azure functionapp publish func-iot-monitor --python
cd ..

echo "Functions deployed."
```

**Rollback point:** Redeploy the previous function code version. Re-add SAS connection string settings.

---

## Step 5: Update Logic Apps connectors

### Before (SAS API connection)

Logic Apps Consumption tier uses API connections with embedded SAS keys.

### After (Managed Identity HTTP action)

Replace the IoT Hub API connection with an HTTP action using managed identity authentication.

```json
{
    "Get_Device_Twin": {
        "type": "Http",
        "inputs": {
            "method": "GET",
            "uri": "https://@{parameters('iotHubHostname')}/twins/@{triggerBody()?['deviceId']}?api-version=2021-04-12",
            "authentication": {
                "type": "ManagedServiceIdentity",
                "audience": "https://iothubs.azure.net"
            }
        },
        "runAfter": {}
    }
}
```

```bash
# Update Logic App parameters
az logicapp config appsettings set \
  -g "$RG" -n "logic-device-alerts" \
  --settings "iotHubHostname=$IOT_HUB_HOSTNAME"

# Remove old API connection (if applicable)
az resource delete \
  --resource-group "$RG" \
  --resource-type "Microsoft.Web/connections" \
  --name "iot-hub-connection" 2>/dev/null || echo "No API connection to delete."
```

**Rollback point:** Recreate the API connection with SAS key. Revert Logic App definition.

---

## Step 6: Update event processing pipelines

If you have standalone event processors consuming from the IoT Hub built-in Event Hub-compatible endpoint:

### Before (SAS)

```python
# event_processor.py (BEFORE)
from azure.eventhub import EventHubConsumerClient

conn_str = os.environ["IOTHUB_EVENTHUB_CONN_STR"]
client = EventHubConsumerClient.from_connection_string(
    conn_str=conn_str,
    consumer_group="$Default",
)
```

### After (Managed Identity)

```python
# event_processor.py (AFTER)
from azure.eventhub import EventHubConsumerClient
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()
eh_namespace = os.environ["EVENTHUB_NAMESPACE"]  # e.g., "ns-iot-prod.servicebus.windows.net"
iot_hub_name = os.environ["IOTHUB_NAME"]

client = EventHubConsumerClient(
    fully_qualified_namespace=eh_namespace,
    eventhub_name=iot_hub_name,
    consumer_group="$Default",
    credential=credential,
)

def on_event(partition_context, event):
    device_id = event.system_properties.get(b"iothub-connection-device-id", b"").decode()
    print(f"Event from {device_id}: {event.body_as_str()}")
    partition_context.update_checkpoint(event)

with client:
    client.receive(
        on_event=on_event,
        starting_position="-1",
    )
```

**Rollback point:** Revert to SAS connection string. Redeploy processor.

---

## Step 7: Remove SAS connection strings from Key Vault / config

After verifying all services work with managed identity, remove SAS secrets.

```bash
echo "=== Removing SAS Secrets ==="

# List IoT Hub-related secrets in Key Vault
SECRETS=$(az keyvault secret list --vault-name "$KV_NAME" \
  --query "[?contains(name, 'iothub') || contains(name, 'iot-hub')].name" -o tsv)

for SECRET in $SECRETS; do
  echo "  Soft-deleting secret: $SECRET"
  az keyvault secret delete --vault-name "$KV_NAME" --name "$SECRET"
done

echo ""
echo "Secrets soft-deleted. They can be recovered for 90 days if needed."
echo "To permanently purge (after verification):"
echo "  az keyvault secret purge --vault-name $KV_NAME --name <secret-name>"

# Verify no app settings reference SAS connection strings
echo ""
echo "=== Verify No SAS Settings Remain ==="
for FUNC in $(az functionapp list -g "$RG" --query "[].name" -o tsv); do
  SAS_SETTINGS=$(az functionapp config appsettings list -g "$RG" -n "$FUNC" \
    --query "[?contains(value || '', 'SharedAccessKey')].name" -o tsv 2>/dev/null)
  if [ -n "$SAS_SETTINGS" ]; then
    echo "  WARNING: $FUNC still has SAS settings: $SAS_SETTINGS"
  else
    echo "  OK: $FUNC - no SAS settings"
  fi
done
```

**Rollback point:** Recover soft-deleted secrets with `az keyvault secret recover`.

---

## Step 8: Validate end-to-end

```bash
echo "=== End-to-End Validation ==="

# 1. Check Function App health
echo "--- Function App Health ---"
for FUNC in $(az functionapp list -g "$RG" --query "[].name" -o tsv); do
  STATUS=$(az functionapp show -g "$RG" -n "$FUNC" --query state -o tsv)
  echo "  $FUNC: $STATUS"
done

# 2. Check recent Function invocations
echo ""
echo "--- Recent Function Invocations ---"
az monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_WORKSPACE_ID" \
  --analytics-query "
    FunctionAppLogs
    | where TimeGenerated > ago(1h)
    | where FunctionName contains 'iot'
    | summarize
        Invocations = count(),
        Errors = countif(Level == 'Error')
        by FunctionName
  " -o table 2>/dev/null || echo "  (Log Analytics query - check portal)"

# 3. Verify managed identity sign-ins
echo ""
echo "--- Managed Identity Sign-Ins ---"
az monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_WORKSPACE_ID" \
  --analytics-query "
    ManagedIdentitySignInLogs
    | where TimeGenerated > ago(1h)
    | where ResourceDisplayName contains 'IoT'
    | summarize count() by ServicePrincipalName, ResultType
  " -o table 2>/dev/null || echo "  (Log Analytics query - check portal)"

# 4. Verify no SAS authentication in IoT Hub logs
echo ""
echo "--- SAS Auth Check (should be empty) ---"
az monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_WORKSPACE_ID" \
  --analytics-query "
    AzureDiagnostics
    | where ResourceProvider == 'MICROSOFT.DEVICES'
    | where Category == 'Connections'
    | where TimeGenerated > ago(1h)
    | where authType_s == 'sas'
    | summarize count()
  " -o table 2>/dev/null || echo "  (Log Analytics query - check portal)"

# 5. Send a test message and verify end-to-end flow
echo ""
echo "--- End-to-End Test ---"
# If you have a test device, send a message and verify it flows through
# the updated Functions/Logic Apps
echo "  Manual step: Send test telemetry from a device and verify"
echo "  it appears in the downstream service (dashboard, alerts, etc.)"
```

---

## Post-migration checklist

- [ ] All Function Apps using managed identity (no SAS connection strings)
- [ ] All Logic Apps using managed identity HTTP actions
- [ ] All event processors using managed identity
- [ ] SAS connection string secrets removed from Key Vault
- [ ] SAS connection string app settings removed from all services
- [ ] RBAC roles assigned with least privilege
- [ ] Managed identity sign-in logs flowing to Log Analytics
- [ ] No SAS authentication events in IoT Hub logs
- [ ] Monitoring alerts configured (see [Monitoring Migration](monitoring-migration.md))
- [ ] Bicep/Terraform templates updated (see [Managed Identity Migration](managed-identity-migration.md))
- [ ] CI/CD pipeline updated (no SAS key deployment outputs)
- [ ] Team trained on managed identity debugging

---

## Troubleshooting

| Symptom                                     | Likely cause                                             | Resolution                                                                                    |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Function returns 403 when accessing IoT Hub | RBAC role not assigned or not propagated                 | Verify role assignment; wait up to 30 minutes for propagation                                 |
| `DefaultAzureCredential` fails locally      | No local credential available                            | Use `az login` or set `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_CLIENT_SECRET` for local dev |
| Event Hub trigger stops firing              | Missing Event Hubs Data Receiver role                    | Assign `a638d3c7-ab3a-418d-83e6-5f17a39d4fde` on Event Hub namespace                          |
| Logic App HTTP action returns 401           | Wrong audience in auth config                            | Use `https://iothubs.azure.net` as the audience                                               |
| Function works locally but fails in Azure   | Local uses `az login` creds, Azure uses managed identity | Ensure managed identity is enabled and has correct RBAC                                       |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Managed Identity Migration](managed-identity-migration.md) | [Monitoring](monitoring-migration.md) | [Feature Mapping](feature-mapping-complete.md)
