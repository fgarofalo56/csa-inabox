# Managed Identity Migration — Service-to-Service

**Migrate backend services from SAS connection strings to managed identities with Azure RBAC for IoT Hub access.**

> **Finding:** CSA-0025 (HIGH, BREAKING) | **Ballot:** AQ-0014 (approved)

---

## Overview

Backend services -- Azure Functions, Logic Apps, Web Apps, container-based processors -- have historically connected to IoT Hub using SAS connection strings. These connection strings contain shared access keys that grant broad, policy-level access to the entire IoT Hub.

Managed Identity replaces this model entirely. The compute resource authenticates to IoT Hub using its Azure-managed identity, with access scoped by Azure RBAC roles. No secrets are stored, rotated, or transmitted.

---

## System-assigned vs User-assigned managed identity

| Attribute           | System-assigned                                         | User-assigned                                                                      |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Lifecycle**       | Tied to the resource (deleted when resource is deleted) | Independent (persists across resource deletions)                                   |
| **Sharing**         | One per resource                                        | One identity shared across multiple resources                                      |
| **Use case**        | Single-purpose services                                 | Shared access pattern across multiple services                                     |
| **Bicep**           | `identity: { type: 'SystemAssigned' }`                  | `identity: { type: 'UserAssigned', userAssignedIdentities: { '${uami.id}': {} } }` |
| **RBAC**            | Assign to each resource individually                    | Assign once, apply to many resources                                               |
| **Rotation**        | Automatic                                               | Automatic                                                                          |
| **Recommended for** | Production services with 1:1 resource-to-identity       | Dev/test or shared-access patterns                                                 |

### When to use each

**System-assigned (default recommendation):**

- Each service has exactly one purpose
- You want automatic cleanup when the service is deleted
- You need clear audit attribution (each identity maps to exactly one service)

**User-assigned:**

- Multiple services need identical IoT Hub access
- You are using deployment slots (staging/production swap) and need consistent identity
- Your services are frequently recreated (e.g., container instances) and you want to avoid RBAC reassignment

---

## IoT Hub RBAC roles

### Available roles

| Role                         | Role ID                                | Permissions                                                             | Use when                                    |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| IoT Hub Data Contributor     | `4fc6c259-987e-4a07-842e-c321cc9d413f` | Full data plane: registry CRUD, twins, direct methods, C2D, file upload | Backend API needing full device management  |
| IoT Hub Data Reader          | `b447c946-2db7-41ec-983d-d8bf3b1c77e3` | Read device registry, read twins, read file upload notifications        | Monitoring, dashboards, read-only analytics |
| IoT Hub Registry Contributor | `4ea46cd5-c1b2-4a8e-910b-273211f9ce47` | Create, update, delete device identities                                | Device lifecycle management service         |
| IoT Hub Twin Contributor     | `494bdba2-168f-4f31-a0a1-191d2f7c028c` | Read and write device/module twins                                      | Configuration management service            |
| Contributor                  | (built-in)                             | Control plane: manage IoT Hub resource                                  | Infrastructure automation (Bicep/Terraform) |
| Reader                       | (built-in)                             | Control plane: view IoT Hub configuration                               | Monitoring, compliance scanners             |

### Least-privilege mapping

Map each service to the minimum role it needs:

| Service function                          | Minimum RBAC role                      | Replaces SAS policy |
| ----------------------------------------- | -------------------------------------- | ------------------- |
| Process telemetry from Event Hub endpoint | Azure Event Hubs Data Receiver (on EH) | `service`           |
| Read device twins for dashboard           | IoT Hub Data Reader                    | `registryRead`      |
| Update device twins (desired properties)  | IoT Hub Twin Contributor               | `registryReadWrite` |
| Invoke direct methods on devices          | IoT Hub Data Contributor               | `service`           |
| Register/delete device identities         | IoT Hub Registry Contributor           | `registryReadWrite` |
| Full device management API                | IoT Hub Data Contributor               | `iothubowner`       |
| Send cloud-to-device messages             | IoT Hub Data Contributor               | `service`           |

---

## Azure Functions with IoT Hub trigger

### Before (SAS connection string)

```csharp
// Azure Function with SAS-based IoT Hub trigger (BEFORE)
// host.json or local.settings.json contains:
// "IoTHubConnection": "Endpoint=sb://...;SharedAccessKeyName=...;SharedAccessKey=..."

[FunctionName("ProcessTelemetry")]
public static async Task Run(
    [IoTHubTrigger("messages/events",
        Connection = "IoTHubConnection")]
    EventData message,
    ILogger log)
{
    log.LogInformation($"Message: {Encoding.UTF8.GetString(message.Body)}");
}
```

### After (Managed Identity)

```csharp
// Azure Function with identity-based IoT Hub trigger (AFTER)
// host.json contains:
// "IoTHubConnection__fullyQualifiedNamespace": "hub-prod.servicebus.windows.net"
// No SharedAccessKey. No connection string.

[FunctionName("ProcessTelemetry")]
public static async Task Run(
    [EventHubTrigger("",  // empty = use IoT Hub built-in endpoint
        Connection = "IoTHubConnection")]
    EventData message,
    ILogger log)
{
    log.LogInformation($"Message: {Encoding.UTF8.GetString(message.Body)}");
}
```

### Bicep for Functions with managed identity

```bicep
// Azure Function App with system-assigned managed identity
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'DOTNET-ISOLATED|8.0'
      appSettings: [
        {
          name: 'IoTHubConnection__fullyQualifiedNamespace'
          value: '${eventHubNamespaceName}.servicebus.windows.net'
        }
        {
          name: 'IOTHUB_HOSTNAME'
          value: '${iotHubName}.azure-devices.net'
        }
        // No connection string settings
      ]
    }
  }
}

// RBAC: Function -> Event Hubs Data Receiver (for trigger)
resource functionEventHubRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(functionApp.id, eventHubNamespace.id, 'EventHubsDataReceiver')
  scope: eventHubNamespace
  properties: {
    principalId: functionApp.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'a638d3c7-ab3a-418d-83e6-5f17a39d4fde' // Azure Event Hubs Data Receiver
    )
    principalType: 'ServicePrincipal'
  }
}

// RBAC: Function -> IoT Hub Data Contributor (for device management)
resource functionIoTHubRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(functionApp.id, iotHub.id, 'IoTHubDataContributor')
  scope: iotHub
  properties: {
    principalId: functionApp.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4fc6c259-987e-4a07-842e-c321cc9d413f' // IoT Hub Data Contributor
    )
    principalType: 'ServicePrincipal'
  }
}
```

---

## Logic Apps IoT Hub connector

### Before (SAS connection string)

Logic Apps IoT Hub connector requires a connection string with SAS key. This is stored as an API connection resource.

```json
{
    "type": "Microsoft.Web/connections",
    "apiVersion": "2016-06-01",
    "properties": {
        "api": {
            "id": "[subscriptionResourceId('Microsoft.Web/locations/managedApis', 'azureiotdevices')]"
        },
        "parameterValues": {
            "iotHubConnectionString": "HostName=hub-prod.azure-devices.net;SharedAccessKeyName=iothubowner;SharedAccessKey=..."
        }
    }
}
```

### After (Managed Identity)

Logic Apps Standard supports managed identity for IoT Hub access through the Azure Resource Manager connector or direct HTTP actions with managed identity authentication.

```json
{
    "type": "Microsoft.Logic/workflows",
    "properties": {
        "definition": {
            "actions": {
                "Get_Device_Twin": {
                    "type": "Http",
                    "inputs": {
                        "method": "GET",
                        "uri": "https://hub-prod.azure-devices.net/twins/sensor-001?api-version=2021-04-12",
                        "authentication": {
                            "type": "ManagedServiceIdentity",
                            "audience": "https://iothubs.azure.net"
                        }
                    }
                }
            }
        }
    }
}
```

### Bicep for Logic App with managed identity

```bicep
resource logicApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: logicAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    // ... workflow definition
  }
}

// RBAC: Logic App -> IoT Hub Data Reader
resource logicAppIoTHubRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(logicApp.id, iotHub.id, 'IoTHubDataReader')
  scope: iotHub
  properties: {
    principalId: logicApp.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'b447c946-2db7-41ec-983d-d8bf3b1c77e3' // IoT Hub Data Reader
    )
    principalType: 'ServicePrincipal'
  }
}
```

---

## Event Hub compatible endpoint

IoT Hub exposes a built-in Event Hub-compatible endpoint for telemetry consumption. Previously, consumers used the IoT Hub connection string. With Entra, consumers use managed identity to access the underlying Event Hub namespace.

### Before (SAS)

```python
# Event processor using SAS connection string (BEFORE)
from azure.eventhub import EventHubConsumerClient

conn_str = os.environ["IOTHUB_EVENTHUB_CONNECTION_STRING"]
# "Endpoint=sb://ihsuprodXXres.servicebus.windows.net/;
#  SharedAccessKeyName=iothubowner;SharedAccessKey=...;
#  EntityPath=hub-prod"

client = EventHubConsumerClient.from_connection_string(
    conn_str=conn_str,
    consumer_group="$Default",
)
```

### After (Managed Identity)

```python
# Event processor using Managed Identity (AFTER)
from azure.eventhub import EventHubConsumerClient
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()

client = EventHubConsumerClient(
    fully_qualified_namespace=f"{event_hub_namespace}.servicebus.windows.net",
    eventhub_name=iot_hub_name,
    consumer_group="$Default",
    credential=credential,
)
```

### Bicep for Event Hub consumer role

```bicep
// IoT Hub routing uses identity-based auth to send to Event Hub
resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' = {
  name: iotHubName
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    routing: {
      endpoints: {
        eventHubs: [
          {
            name: 'telemetry-eh'
            authenticationType: 'identityBased'
            endpointUri: 'sb://${eventHubNamespaceName}.servicebus.windows.net'
            entityPath: eventHubName
          }
        ]
      }
    }
  }
}

// RBAC: IoT Hub -> Event Hubs Data Sender (for routing)
resource iotHubEventHubSenderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(iotHub.id, eventHubNamespace.id, 'EventHubsDataSender')
  scope: eventHubNamespace
  properties: {
    principalId: iotHub.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '2b629674-e913-4c01-ae53-ef4638d8f975' // Azure Event Hubs Data Sender
    )
    principalType: 'ServicePrincipal'
  }
}
```

---

## Service-side code migration: Python

### Complete before/after example

```python
# ===== BEFORE: SAS-based IoT Hub service client =====

import os
from azure.iot.hub import IoTHubRegistryManager
from azure.iot.hub.models import Twin, TwinProperties

# SAS connection string from environment
conn_str = os.environ["IOTHUB_CONNECTION_STRING"]
registry = IoTHubRegistryManager(conn_str)

# Read device twin
twin = registry.get_twin("sensor-001")
print(f"Reported temperature: {twin.properties.reported.get('temperature')}")

# Update desired properties
patch = Twin(properties=TwinProperties(desired={"targetTemp": 72}))
registry.update_twin("sensor-001", patch, twin.etag)

# Invoke direct method
response = registry.invoke_device_method("sensor-001", {
    "methodName": "reboot",
    "payload": {"delay": 5},
    "responseTimeoutInSeconds": 30,
})
print(f"Method response: {response.status}")
```

```python
# ===== AFTER: Managed Identity-based IoT Hub service client =====

import os
from azure.identity import DefaultAzureCredential
from azure.iot.hub import IoTHubRegistryManager
from azure.iot.hub.models import Twin, TwinProperties

# No secrets -- use managed identity
credential = DefaultAzureCredential()
iot_hub_hostname = os.environ["IOTHUB_HOSTNAME"]  # "hub-prod.azure-devices.net"

registry = IoTHubRegistryManager.from_token_credential(
    url=f"https://{iot_hub_hostname}",
    token_credential=credential,
)

# Read device twin (identical API)
twin = registry.get_twin("sensor-001")
print(f"Reported temperature: {twin.properties.reported.get('temperature')}")

# Update desired properties (identical API)
patch = Twin(properties=TwinProperties(desired={"targetTemp": 72}))
registry.update_twin("sensor-001", patch, twin.etag)

# Invoke direct method (identical API)
response = registry.invoke_device_method("sensor-001", {
    "methodName": "reboot",
    "payload": {"delay": 5},
    "responseTimeoutInSeconds": 30,
})
print(f"Method response: {response.status}")
```

**Key difference:** Only the client initialization changes. All subsequent API calls are identical.

---

## Terraform alternative

For teams using Terraform instead of Bicep:

```hcl
# Managed identity for Azure Function
resource "azurerm_linux_function_app" "iot_processor" {
  name                = "func-iot-processor"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  service_plan_id     = azurerm_service_plan.plan.id

  identity {
    type = "SystemAssigned"
  }

  app_settings = {
    "IOTHUB_HOSTNAME" = "${azurerm_iothub.hub.hostname}"
    # No connection string
  }

  storage_account_name       = azurerm_storage_account.sa.name
  storage_account_access_key = azurerm_storage_account.sa.primary_access_key
}

# RBAC: Function -> IoT Hub Data Contributor
resource "azurerm_role_assignment" "func_iothub" {
  scope                = azurerm_iothub.hub.id
  role_definition_name = "IoT Hub Data Contributor"
  principal_id         = azurerm_linux_function_app.iot_processor.identity[0].principal_id
}

# RBAC: Function -> Event Hubs Data Receiver
resource "azurerm_role_assignment" "func_eventhub" {
  scope                = azurerm_eventhub_namespace.ns.id
  role_definition_name = "Azure Event Hubs Data Receiver"
  principal_id         = azurerm_linux_function_app.iot_processor.identity[0].principal_id
}
```

---

## Migration checklist

- [ ] Inventory all services using SAS connection strings
- [ ] Enable managed identity on each service
- [ ] Assign appropriate RBAC roles (least privilege)
- [ ] Wait for RBAC propagation (up to 30 minutes)
- [ ] Update application code to use `DefaultAzureCredential`
- [ ] Update app settings (replace connection strings with hostname)
- [ ] Test each service with managed identity (SAS still available as fallback)
- [ ] Remove SAS connection strings from Key Vault
- [ ] Remove SAS connection string app settings
- [ ] Set `disableLocalAuth: true` on IoT Hub
- [ ] Verify all services still function
- [ ] Update Bicep/Terraform templates

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Feature Mapping](feature-mapping-complete.md) | [Tutorial: Backend Migration](tutorial-backend-migration.md) | [Monitoring](monitoring-migration.md)
