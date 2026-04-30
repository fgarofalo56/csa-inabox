# Authentication Pattern Mapping — SAS to Entra

**Every SAS-based authentication pattern mapped to its Entra ID equivalent with Bicep before/after code snippets.**

> **Finding:** CSA-0025 (HIGH, BREAKING) | **Ballot:** AQ-0014 (approved)

---

## Pattern overview

This document maps each SAS-based authentication pattern used in IoT Hub and DPS to its Entra equivalent. Each pattern includes the SAS approach, the Entra replacement, migration complexity, and Bicep code showing the before and after states.

| SAS pattern                        | Entra replacement                         | Complexity | Guide                                                       |
| ---------------------------------- | ----------------------------------------- | ---------- | ----------------------------------------------------------- |
| SAS device symmetric key           | X.509 device certificate                  | Medium     | [X.509 Migration](x509-migration.md)                        |
| SAS connection string (service)    | Managed Identity + Azure RBAC             | Low        | [Managed Identity Migration](managed-identity-migration.md) |
| SAS IoT Hub shared access policies | Entra app registrations + RBAC roles      | Low        | [Managed Identity Migration](managed-identity-migration.md) |
| DPS SAS enrollment group           | DPS X.509 enrollment group                | Medium     | [DPS Migration](dps-migration.md)                           |
| SAS token generation (device)      | Certificate thumbprint authentication     | Medium     | [X.509 Migration](x509-migration.md)                        |
| SAS token generation (service)     | Managed Identity token acquisition        | Low        | [Managed Identity Migration](managed-identity-migration.md) |
| Connection retry with SAS          | Connection retry with certificate renewal | Medium     | [X.509 Migration](x509-migration.md)                        |
| Device twin auth via SAS           | Entra-scoped device twin access           | Low        | This document                                               |

---

## Pattern 1: SAS device symmetric key to X.509 device certificate

### Before (SAS)

Each device is provisioned with a symmetric key from IoT Hub's device identity registry. The device generates a SAS token from this key and presents it during MQTT/AMQP connection.

```python
# Device-side SAS authentication (BEFORE)
from azure.iot.device import IoTHubDeviceClient

# Connection string contains the device symmetric key
conn_str = (
    "HostName=hub-prod.azure-devices.net;"
    "DeviceId=sensor-floor3-unit47;"
    "SharedAccessKey=<device-symmetric-key>"
)

client = IoTHubDeviceClient.create_from_connection_string(conn_str)
client.connect()
```

### After (X.509)

Each device holds a private key (ideally in an HSM/TPM) and an X.509 certificate signed by a CA registered with IoT Hub or DPS. The device presents the certificate during TLS handshake -- the private key never leaves the device.

```python
# Device-side X.509 authentication (AFTER)
from azure.iot.device import IoTHubDeviceClient, X509

x509 = X509(
    cert_file="/certs/device-sensor-floor3-unit47.pem",
    key_file="/certs/device-sensor-floor3-unit47.key",
    pass_phrase="optional-passphrase",
)

client = IoTHubDeviceClient.create_from_x509_certificate(
    hostname="hub-prod.azure-devices.net",
    device_id="sensor-floor3-unit47",
    x509=x509,
)
client.connect()
```

### Bicep change

```bicep
// BEFORE: IoT Hub allows SAS authentication
resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' = {
  name: iotHubName
  location: location
  sku: {
    name: 'S1'
    capacity: 1
  }
  properties: {
    disableLocalAuth: false  // SAS keys allowed
    // Default shared access policies are created automatically
  }
}

// AFTER: IoT Hub requires Entra authentication only
resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' = {
  name: iotHubName
  location: location
  sku: {
    name: 'S1'
    capacity: 1
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    disableLocalAuth: true   // SAS keys BLOCKED
    authorizationPolicies: [] // No SAS policies
  }
}
```

### Migration notes

- Certificate infrastructure must be established before this migration
- Device firmware/software update required
- HSM/TPM recommended for production; required for IL5
- See [X.509 Migration Guide](x509-migration.md) for full procedure

---

## Pattern 2: SAS connection string (service) to Managed Identity

### Before (SAS)

Backend services authenticate to IoT Hub using a connection string containing a shared access key. The connection string is typically stored in Key Vault, app settings, or environment variables.

```python
# Service-side SAS authentication (BEFORE)
from azure.iot.hub import IoTHubRegistryManager

conn_str = os.environ["IOTHUB_CONNECTION_STRING"]
# "HostName=hub-prod.azure-devices.net;
#  SharedAccessKeyName=iothubowner;
#  SharedAccessKey=dGhpcyBpcyBhIGZha2Uga2V5..."

registry = IoTHubRegistryManager(conn_str)
device_twin = registry.get_twin("sensor-floor3-unit47")
```

### After (Managed Identity)

Backend services authenticate using their managed identity. No credentials are stored, managed, or rotated.

```python
# Service-side Managed Identity authentication (AFTER)
from azure.identity import DefaultAzureCredential
from azure.iot.hub import IoTHubRegistryManager

credential = DefaultAzureCredential()
registry = IoTHubRegistryManager.from_token_credential(
    url=f"https://{iot_hub_name}.azure-devices.net",
    token_credential=credential,
)
device_twin = registry.get_twin("sensor-floor3-unit47")
```

### Bicep change

```bicep
// BEFORE: Azure Function using SAS connection string
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp'
  properties: {
    siteConfig: {
      appSettings: [
        {
          name: 'IOTHUB_CONNECTION_STRING'
          value: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=iothub-conn-str)'
        }
      ]
    }
  }
}

// AFTER: Azure Function using Managed Identity
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    siteConfig: {
      appSettings: [
        {
          name: 'IOTHUB_HOSTNAME'
          value: '${iotHubName}.azure-devices.net'
        }
        // No connection string. No secret reference.
      ]
    }
  }
}

// RBAC role assignment: Function -> IoT Hub Data Contributor
resource functionIoTHubRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(functionApp.id, iotHub.id, iotHubDataContributorRoleId)
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

### Migration notes

- Managed identity must be enabled on the compute resource
- RBAC role must be assigned before SAS connection string is removed
- Allow up to 30 minutes for RBAC propagation (typically < 60 seconds)
- See [Managed Identity Migration Guide](managed-identity-migration.md) for full procedure

---

## Pattern 3: SAS IoT Hub shared access policies to Entra RBAC roles

### Before (SAS)

IoT Hub provides five built-in shared access policies. Each policy grants broad, coarse-grained access.

| SAS policy          | Permissions                          |
| ------------------- | ------------------------------------ |
| `iothubowner`       | All operations (full control)        |
| `service`           | Service-connect, registry read/write |
| `device`            | Device connect                       |
| `registryRead`      | Registry read                        |
| `registryReadWrite` | Registry read + write                |

### After (Entra RBAC)

Entra provides granular, least-privilege roles.

| Entra RBAC role              | Role ID                                | Permissions                                           |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------- |
| IoT Hub Data Contributor     | `4fc6c259-987e-4a07-842e-c321cc9d413f` | Full data plane (registry, twin, direct methods, C2D) |
| IoT Hub Data Reader          | `b447c946-2db7-41ec-983d-d8bf3b1c77e3` | Read device registry, read twins                      |
| IoT Hub Registry Contributor | `4ea46cd5-c1b2-4a8e-910b-273211f9ce47` | Create/update/delete device identities                |
| IoT Hub Twin Contributor     | `494bdba2-168f-4f31-a0a1-191d2f7c028c` | Read/write device twins                               |
| Contributor                  | (built-in)                             | Control plane (manage IoT Hub resource itself)        |
| Reader                       | (built-in)                             | Control plane read (view IoT Hub configuration)       |

### Mapping

| SAS policy          | Entra RBAC role(s)                     | Notes                                           |
| ------------------- | -------------------------------------- | ----------------------------------------------- |
| `iothubowner`       | IoT Hub Data Contributor + Contributor | Split data plane and control plane              |
| `service`           | IoT Hub Data Contributor               | Or IoT Hub Data Reader for read-only services   |
| `device`            | N/A (devices use X.509)                | Device authentication via certificate, not RBAC |
| `registryRead`      | IoT Hub Data Reader                    | Least-privilege read access                     |
| `registryReadWrite` | IoT Hub Registry Contributor           | Device identity management only                 |

### Bicep change

```bicep
// BEFORE: Relying on built-in SAS policies (implicit)
resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' = {
  name: iotHubName
  properties: {
    disableLocalAuth: false
    // Built-in policies: iothubowner, service, device,
    // registryRead, registryReadWrite created automatically
  }
}

// AFTER: Explicit RBAC role assignments
resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' = {
  name: iotHubName
  properties: {
    disableLocalAuth: true
    authorizationPolicies: []
  }
}

// Each service gets exactly the role it needs
resource backendApiRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(backendApi.id, iotHub.id, 'IoTHubDataContributor')
  scope: iotHub
  properties: {
    principalId: backendApi.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4fc6c259-987e-4a07-842e-c321cc9d413f'
    )
    principalType: 'ServicePrincipal'
  }
}

resource monitoringRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(monitoring.id, iotHub.id, 'IoTHubDataReader')
  scope: iotHub
  properties: {
    principalId: monitoring.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'b447c946-2db7-41ec-983d-d8bf3b1c77e3'
    )
    principalType: 'ServicePrincipal'
  }
}
```

---

## Pattern 4: DPS SAS enrollment group to X.509 enrollment group

### Before (SAS)

DPS uses a symmetric key enrollment group. Devices derive their individual keys from the group key using HMAC-SHA256.

```python
# DPS symmetric key provisioning (BEFORE)
from azure.iot.device import ProvisioningDeviceClient
import hmac, hashlib, base64

# Derive device key from group key
group_key = base64.b64decode(os.environ["DPS_GROUP_KEY"])
device_key = base64.b64encode(
    hmac.new(group_key, device_id.encode(), hashlib.sha256).digest()
).decode()

client = ProvisioningDeviceClient.create_from_symmetric_key(
    provisioning_host="global.azure-devices-provisioning.net",
    registration_id=device_id,
    id_scope=dps_id_scope,
    symmetric_key=device_key,
)
result = client.register()
```

### After (X.509)

DPS uses an X.509 enrollment group. Devices present their leaf certificate signed by the enrollment group's CA.

```python
# DPS X.509 provisioning (AFTER)
from azure.iot.device import ProvisioningDeviceClient, X509

x509 = X509(
    cert_file=f"/certs/{device_id}.pem",
    key_file=f"/certs/{device_id}.key",
)

client = ProvisioningDeviceClient.create_from_x509_certificate(
    provisioning_host="global.azure-devices-provisioning.net",
    registration_id=device_id,
    id_scope=dps_id_scope,
    x509=x509,
)
result = client.register()
```

### Migration notes

- Root or intermediate CA certificate must be uploaded and verified in DPS
- Each device needs a unique leaf certificate signed by the CA
- See [DPS Migration Guide](dps-migration.md) for full procedure

---

## Pattern 5: SAS token generation to certificate thumbprint authentication

### Before (SAS)

The device SDK generates a SAS token from the symmetric key. The token has a configurable expiry (typically 1-24 hours) and must be regenerated before expiry.

```python
# SAS token generation (SDK handles internally)
# Token format:
# SharedAccessSignature sig={signature}&se={expiry}&skn={policyName}&sr={resourceURI}
```

### After (X.509)

The device presents its X.509 certificate during TLS handshake. IoT Hub validates the certificate chain against registered CAs. No token generation is needed -- authentication is at the transport layer.

```
TLS Handshake:
  Client Hello
  Server Hello + Server Certificate
  Certificate Request
  Client Certificate (device leaf cert)     ◄── Authentication happens here
  Client Key Exchange
  Certificate Verify (proves private key)   ◄── No secret transmitted
  Finished
```

### Key difference

- SAS: Authentication at the application layer (token in MQTT CONNECT)
- X.509: Authentication at the transport layer (certificate in TLS handshake)
- X.509 private key **never leaves the device** -- only a proof of possession is transmitted

---

## Pattern 6: Connection retry with SAS to connection retry with certificate renewal

### Before (SAS)

When a SAS token expires, the device must generate a new token and reconnect. If the underlying key has been rotated (e.g., during a planned key rotation), the device cannot generate a valid token and fails permanently until reconfigured.

```python
# SAS connection retry (BEFORE)
def connect_with_retry(conn_str, max_retries=5):
    for attempt in range(max_retries):
        try:
            client = IoTHubDeviceClient.create_from_connection_string(conn_str)
            client.connect()
            return client
        except Exception as e:
            if "401" in str(e):
                # Key may have been rotated -- cannot recover automatically
                log.error("Authentication failed. Key may be rotated.")
                raise  # Permanent failure
            time.sleep(min(2 ** attempt, 60))
    raise ConnectionError("Max retries exceeded")
```

### After (X.509)

When a certificate approaches expiry, the device can re-provision through DPS to obtain updated registration (and potentially a new certificate if using an automated certificate issuance pipeline). The private key remains on the device.

```python
# X.509 connection retry with certificate awareness (AFTER)
import datetime

def connect_with_cert_awareness(hostname, device_id, cert_path, key_path):
    # Check certificate expiry
    cert = load_certificate(cert_path)
    days_until_expiry = (cert.not_valid_after - datetime.datetime.utcnow()).days

    if days_until_expiry < 30:
        log.warning(f"Certificate expires in {days_until_expiry} days. "
                    "Triggering re-provisioning.")
        reprovision_via_dps(device_id, cert_path, key_path)

    x509 = X509(cert_file=cert_path, key_file=key_path)
    client = IoTHubDeviceClient.create_from_x509_certificate(
        hostname=hostname,
        device_id=device_id,
        x509=x509,
    )

    def on_connection_state_change():
        if not client.connected:
            log.info("Disconnected. Reconnecting with existing certificate.")
            client.connect()  # SDK handles TLS handshake with same cert

    client.on_connection_state_change = on_connection_state_change
    client.connect()
    return client
```

---

## Pattern 7: Device twin auth via SAS to Entra-scoped device twin access

### Before (SAS)

Service applications access device twins using a connection string with `service` or `iothubowner` policy. This grants access to **all** device twins with no per-device scoping.

```python
# Service reads ALL device twins with SAS (BEFORE)
registry = IoTHubRegistryManager(conn_str)
# This single connection string grants access to every device twin
twin_a = registry.get_twin("device-a")
twin_b = registry.get_twin("device-b")
twin_z = registry.get_twin("device-z")
# No differentiation in access scope
```

### After (Entra RBAC)

Service applications access device twins using managed identity. Access is scoped by RBAC role assignment. Different services can have different levels of access.

```python
# Service reads device twins with Managed Identity (AFTER)
credential = DefaultAzureCredential()
registry = IoTHubRegistryManager.from_token_credential(
    url=f"https://{iot_hub_name}.azure-devices.net",
    token_credential=credential,
)

# Access is governed by the managed identity's RBAC role:
# - IoT Hub Data Reader: read twins only
# - IoT Hub Twin Contributor: read + write twins
# - IoT Hub Data Contributor: full data plane access
twin = registry.get_twin("sensor-floor3-unit47")
```

### Bicep for scoped access

```bicep
// Give the monitoring service read-only twin access
resource monitoringTwinRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(monitoringSvc.id, iotHub.id, 'IoTHubTwinContributor')
  scope: iotHub
  properties: {
    principalId: monitoringSvc.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '494bdba2-168f-4f31-a0a1-191d2f7c028c' // IoT Hub Twin Contributor
    )
    principalType: 'ServicePrincipal'
  }
}

// Give the analytics service read-only access
resource analyticsReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(analyticsSvc.id, iotHub.id, 'IoTHubDataReader')
  scope: iotHub
  properties: {
    principalId: analyticsSvc.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'b447c946-2db7-41ec-983d-d8bf3b1c77e3' // IoT Hub Data Reader
    )
    principalType: 'ServicePrincipal'
  }
}
```

---

## Complete migration matrix

| #   | SAS pattern               | Entra pattern           | Credential change               | Code change        | Bicep change                | Complexity |
| --- | ------------------------- | ----------------------- | ------------------------------- | ------------------ | --------------------------- | ---------- |
| 1   | Device symmetric key      | X.509 certificate       | Key -> cert + private key       | SDK method change  | `disableLocalAuth: true`    | Medium     |
| 2   | Service connection string | Managed Identity        | Conn string -> no credential    | SDK method change  | Add identity + RBAC         | Low        |
| 3   | Shared access policies    | RBAC roles              | Policy name -> role assignment  | None (transparent) | `authorizationPolicies: []` | Low        |
| 4   | DPS SAS enrollment        | DPS X.509 enrollment    | Group key -> CA certificate     | SDK method change  | DPS config update           | Medium     |
| 5   | SAS token generation      | Certificate TLS auth    | Token -> TLS handshake          | SDK method change  | None                        | Medium     |
| 6   | SAS connection retry      | Certificate-aware retry | Token refresh -> cert check     | Custom retry logic | None                        | Medium     |
| 7   | Device twin (SAS)         | Device twin (RBAC)      | Conn string -> managed identity | SDK method change  | Add RBAC assignment         | Low        |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Security Analysis](security-analysis.md) | [X.509 Migration](x509-migration.md) | [Managed Identity Migration](managed-identity-migration.md)
