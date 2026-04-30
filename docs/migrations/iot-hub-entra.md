# IoT Hub & DPS — SAS to Entra-Only Migration

> **Status:** Required for FedRAMP High / IL5 | **Owner:** Platform Security | **Authored:** 2026-04-19 | Expanded 2026-04-30
> **Finding:** CSA-0025 (HIGH, BREAKING) | **Ballot:** AQ-0014 (approved)
> **Applies to:** `examples/iot-streaming/deploy/bicep/iot-hub.bicep`

!!! tip "Expanded Migration Center Available"
    This playbook is the core migration reference. For the complete IoT Hub SAS-to-Entra migration package — including security analysis, deep-dive guides, tutorials, and benchmarks — visit the **[IoT Hub + Entra Migration Center](iot-hub-entra/index.md)**.

    **Quick links:**

    - [Why Entra over SAS (Security Case)](iot-hub-entra/why-entra-over-sas.md)
    - [Security Analysis](iot-hub-entra/security-analysis.md)
    - [Complete Feature Mapping](iot-hub-entra/feature-mapping-complete.md)
    - [Tutorials & Walkthroughs](iot-hub-entra/index.md#tutorials)
    - [Benchmarks & Performance](iot-hub-entra/benchmarks.md)
    - [Best Practices](iot-hub-entra/best-practices.md)

!!! important
**This is a breaking change.** Devices using SAS-key authentication (symmetric
keys, iothubowner, or any SAS connection string) will stop authenticating after
this template is redeployed. All device fleets must complete the migration
before the redeploy window.

---

## Why

Azure IoT Hub and the Device Provisioning Service (DPS) historically supported
Shared Access Signature (SAS) key authentication. SAS keys fail the FedRAMP
High and DoD IL5 baseline for two reasons:

1. **Long-lived credentials.** SAS keys are static secrets. Rotation requires
   a coordinated redeploy of every device and every service caller, and the
   compromise window between rotation cycles is the key's full lifetime.
2. **Key material in deployment history.** Previously, this template called
   `iotHub.listKeys()` inline to build the DPS connection string and the
   Key Vault secret. `listKeys()` return values are written to the ARM
   deployment history, the subscription Activity Log, and (for linked
   deployments) the caller's output payload. Any reader of deployment history
   can read the primary key until the hub is rotated.

The approved posture per CSA-0025 / AQ-0014 is **Entra-only**:

- `disableLocalAuth: true` on the IoT Hub (no SAS client can authenticate).
- System-assigned managed identity on IoT Hub and DPS.
- IoT Hub routing to Event Hubs via identity-based authentication.
- DPS → IoT Hub linking via the DPS managed identity (post-deploy step).
- Device authentication via X.509 or Entra workload identity. Symmetric-key
  device enrollment is no longer supported.

---

## What Changed in Bicep

| Before (SAS)                                                                                    | After (CSA-0025)                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `disableLocalAuth: false` on IoT Hub                                                            | `disableLocalAuth: true`                                                              |
| No `authorizationPolicies` field (defaults to iothubowner + friends)                            | `authorizationPolicies: []` (explicitly empty)                                        |
| No `identity` on IoT Hub                                                                        | `identity: { type: 'SystemAssigned' }`                                                |
| Routing endpoint `connectionString: sendRule.listKeys().primaryConnectionString`                | Routing endpoint `authenticationType: 'identityBased'` + `endpointUri` + `entityPath` |
| No `identity` on DPS                                                                            | `identity: { type: 'SystemAssigned' }`                                                |
| DPS `iotHubs: [ { connectionString: 'HostName=...;SharedAccessKey=${iotHub.listKeys()...}' } ]` | DPS `iotHubs: []` (link established post-deploy via CLI)                              |
| Key Vault secret `iothub-owner-primary-key` populated from `iotHub.listKeys()`                  | Secret REMOVED (no SAS key to materialize)                                            |

Outputs:

| Before                  | After                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `iotHubHostName`        | `iotHubHostName`, **new:** `iotHubResourceId`, `iotHubPrincipalId`                 |
| `dpsName`, `dpsIdScope` | `dpsName`, `dpsResourceId`, `dpsIdScope`, **new:** `dpsEndpoint`, `dpsPrincipalId` |

Two role assignments were added to the template:

1. DPS system-assigned identity → **IoT Hub Data Contributor**
   (`4fc6c259-987e-4a07-842e-c321cc9d413f`) on the IoT Hub.
2. IoT Hub system-assigned identity → **Azure Event Hubs Data Sender**
   (`2b629674-e913-4c01-ae53-ef4638d8f975`) on the Event Hub namespace.

---

## Why DPS Linking Is a Post-Deploy Step

The ARM schema for `Microsoft.Devices/provisioningServices` (through
`2025-02-01-preview` as of this writing) marks
`IotHubDefinitionDescription.connectionString` as **required** and does not
expose `authenticationType` or `identityBased` on the inline link entry.
Identity-based DPS→IoT Hub linking IS supported at the service plane, but
only via the DPS data plane / Azure CLI — not in ARM templates.

Since the IoT Hub has `disableLocalAuth: true`, there is no valid SAS
connection string to emit. The template therefore deploys DPS **unlinked**
(`iotHubs: []`) and the link is established post-deploy as an identity-based
link using the DPS managed identity.

---

## Migration Paths

### Path 1: Device clients using SAS (symmetric key) — migrate to X.509

**Before:** Device authenticates with a symmetric key per-device SAS token
pulled from IoT Hub Device Identity Registry.

**After:** Device authenticates with an X.509 client certificate chained to
a root CA registered in IoT Hub. Certificates are issued per-device (short
lifetime, rotatable via DPS re-provisioning).

Key references:

- [Authenticate a device with X.509 certificates](https://learn.microsoft.com/azure/iot-hub/authenticate-authorize-x509)
- [Provision X.509 devices with DPS](https://learn.microsoft.com/azure/iot-dps/how-to-use-x509-certificates)

### Path 2: Service clients using `listKeys()` + connection strings — migrate to MSI

Before (typical backend code):

```python
from azure.iot.hub import IoTHubRegistryManager
conn_str = os.environ["IOTHUB_CONNECTION_STRING"]  # contains SharedAccessKey=...
registry = IoTHubRegistryManager(conn_str)
```

After:

```python
from azure.identity import DefaultAzureCredential
from azure.iot.hub import IoTHubRegistryManager
cred = DefaultAzureCredential()
registry = IoTHubRegistryManager.from_token_credential(
    f"https://{iot_hub_name}.azure-devices.net",
    cred,
)
```

The backend's managed identity must have **IoT Hub Data Contributor** (for
read/write to device registry + twin) or **IoT Hub Data Reader** (read-only).

### Path 3: DPS SAS enrollment groups — migrate to X.509 enrollment groups

Before: DPS enrollment group with `attestation.type = 'symmetricKey'` and a
shared group key.

After: DPS enrollment group with `attestation.type = 'x509'` and an intermediate
CA certificate. Devices present an X.509 chain rooted at the CA during DPS
registration.

### Path 4: Programmatic DPS → IoT Hub link (CI/CD)

Because DPS linking is now post-deploy, add this step to the deployment pipeline
after `az deployment group create`:

```bash
# 1) Get IoT Hub resource ID and DPS name from deployment outputs
IOT_HUB_ID=$(az deployment group show \
  --resource-group "$RG" --name iot-hub \
  --query properties.outputs.iotHubResourceId.value -o tsv)
DPS_NAME=$(az deployment group show \
  --resource-group "$RG" --name iot-hub \
  --query properties.outputs.dpsName.value -o tsv)

# 2) Create the identity-based linked hub on DPS
az iot dps linked-hub create \
  --dps-name "$DPS_NAME" \
  --resource-group "$RG" \
  --hub-resource-id "$IOT_HUB_ID" \
  --allocation-weight 1 \
  --authentication-type identityBased
```

The DPS system-assigned identity was already granted IoT Hub Data Contributor
by the Bicep template, so the link authenticates as soon as the role
assignment has propagated (typically < 60s).

---

## Copy-Pasteable Entra Access Setup

After deployment, grant operators and services role-based access instead of
SAS keys:

```bash
# Variables
SUB_ID=$(az account show --query id -o tsv)
RG=rg-iot-streaming
IOT_HUB=$(az iot hub list -g "$RG" --query "[0].name" -o tsv)
IOT_HUB_ID=$(az iot hub show -g "$RG" -n "$IOT_HUB" --query id -o tsv)

# Operator: full data plane (read + write device twin, invoke direct methods)
az role assignment create \
  --assignee <operator-user-or-group-object-id> \
  --role "IoT Hub Data Contributor" \
  --scope "$IOT_HUB_ID"

# Read-only analyst: read device twins and telemetry
az role assignment create \
  --assignee <analyst-user-or-group-object-id> \
  --role "IoT Hub Data Reader" \
  --scope "$IOT_HUB_ID"

# Service principal for a backend API (using a user-assigned MI)
az role assignment create \
  --assignee <msi-principal-id> \
  --role "IoT Hub Data Contributor" \
  --scope "$IOT_HUB_ID"

# Verify SAS auth is disabled at the service plane
az iot hub show -g "$RG" -n "$IOT_HUB" \
  --query "properties.disableLocalAuth" -o tsv
# expect: true
```

---

## Rollback (Not Recommended — Exits FedRAMP Path)

!!! warning
Rolling back to SAS takes the deployment off the FedRAMP High / IL5
compliance path. Do not perform this in regulated or government
environments. Document the exception per your SSP.

If a workshop or legacy-device emergency absolutely requires SAS:

1. Edit `examples/iot-streaming/deploy/bicep/iot-hub.bicep`:
    - Flip `disableLocalAuth: true` → `false` on the IoT Hub.
    - Restore `authorizationPolicies` (remove the `[]`) so default policies
      are recreated.
    - Re-add a `connectionString` entry to DPS `iotHubs` (use a
      `@secure()` parameter — never re-add `listKeys()` inline).
2. Redeploy. Existing devices will NOT automatically re-enroll with SAS —
   each device must be re-provisioned via DPS against the re-enabled hub.
3. File a compliance exception referencing CSA-0025. Plan a re-migration
   window with a hard deadline.

---

## Verification Checklist

After deploying the updated Bicep:

- [ ] `az iot hub show ... --query properties.disableLocalAuth -o tsv` returns `true`.
- [ ] `az iot hub show ... --query properties.authorizationPolicies -o tsv` returns `[]`.
- [ ] `az iot hub show ... --query identity.type -o tsv` returns `SystemAssigned`.
- [ ] `az iot dps show ... --query identity.type -o tsv` returns `SystemAssigned`.
- [ ] Post-deploy: `az iot dps linked-hub list --dps-name <dps> -g <rg>`
      shows the IoT Hub with `"authenticationType": "identityBased"`.
- [ ] Key Vault no longer contains `iothub-owner-primary-key`.
- [ ] The deployment's ARM output payload contains no SAS key material
      (grep deployment JSON for `SharedAccessKey=` should return nothing).
- [ ] Legacy device clients using symmetric-key auth fail with `401`.
- [ ] X.509 / Entra device clients authenticate successfully.

---

## References

- **Finding:** CSA-0025 (FedRAMP High / IL5 — IoT Hub SAS posture)
- **Ballot:** AQ-0014 (approved item C3)
- **ADR-0006:** Purview-over-Atlas (identity/governance context)
- **ADR-0010:** Fabric strategic target (identity-first platform strategy)
- Azure docs:
    - [IoT Hub: Authenticate using Entra ID](https://learn.microsoft.com/azure/iot-hub/authenticate-authorize-azure-ad)
    - [Manage IoT Hub with managed identities](https://learn.microsoft.com/azure/iot-hub/iot-hub-managed-identity)
    - [DPS: Disable local authentication paths](https://learn.microsoft.com/azure/iot-dps/concepts-control-access-dps-azure-ad)
    - [IoT Hub routing: identity-based endpoints](https://learn.microsoft.com/azure/iot-hub/iot-hub-managed-identity#egress-connectivity-from-iot-hub-to-other-azure-resources)
