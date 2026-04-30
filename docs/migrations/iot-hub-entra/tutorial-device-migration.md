# Tutorial: Migrate Device Fleet from SAS to X.509

**Step-by-step guide for migrating an IoT device fleet from SAS symmetric key authentication to X.509 certificate-based authentication.**

> **Duration:** 3-4 hours | **Prerequisites:** OpenSSL, Azure CLI, Python 3.9+
> **Finding:** CSA-0025 (HIGH, BREAKING) | **Ballot:** AQ-0014 (approved)

---

## Prerequisites

Before starting this tutorial, ensure you have:

- [ ] Azure subscription with Owner or Contributor + User Access Administrator role
- [ ] Azure CLI 2.50+ with `iot` extension installed (`az extension add --name azure-iot`)
- [ ] OpenSSL 1.1.1+ installed
- [ ] Python 3.9+ with `azure-iot-device` and `azure-identity` packages
- [ ] An existing IoT Hub with devices currently using SAS authentication
- [ ] An existing Device Provisioning Service (DPS) linked to the IoT Hub
- [ ] Access to the device fleet (SSH, firmware update mechanism, or physical access)

### Environment setup

```bash
# Set environment variables used throughout this tutorial
export RG="rg-iot-streaming"
export IOT_HUB=$(az iot hub list -g "$RG" --query "[0].name" -o tsv)
export IOT_HUB_ID=$(az iot hub show -g "$RG" -n "$IOT_HUB" --query id -o tsv)
export IOT_HUB_HOSTNAME=$(az iot hub show -g "$RG" -n "$IOT_HUB" --query properties.hostName -o tsv)
export DPS_NAME=$(az iot dps list -g "$RG" --query "[0].name" -o tsv)
export DPS_ID_SCOPE=$(az iot dps show -g "$RG" -n "$DPS_NAME" --query properties.idScope -o tsv)
export CERT_DIR="./certs"

echo "IoT Hub: $IOT_HUB"
echo "DPS: $DPS_NAME (scope: $DPS_ID_SCOPE)"
```

---

## Step 1: Generate root CA certificate

The root CA is the trust anchor for your entire device certificate hierarchy. It should be generated on an air-gapped workstation and stored offline after generating the intermediate CA.

```bash
# Create certificate directory structure
mkdir -p "$CERT_DIR"/{root,intermediate,devices}

# Generate root CA private key (4096-bit RSA, AES-256 encrypted)
openssl genrsa -aes256 -out "$CERT_DIR/root/root-ca.key" 4096
# Enter a strong passphrase when prompted. Store it in a secure vault.

# Generate self-signed root CA certificate (20-year lifetime)
openssl req -new -x509 -days 7300 \
  -key "$CERT_DIR/root/root-ca.key" \
  -out "$CERT_DIR/root/root-ca.pem" \
  -subj "/CN=CSA IoT Root CA/O=CSA-in-a-Box/OU=IoT Security/C=US/ST=Virginia" \
  -extensions v3_ca \
  -config <(cat <<EOF
[req]
distinguished_name = req_distinguished_name
[req_distinguished_name]
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always, issuer:always
EOF
)

# Verify the root CA certificate
echo "=== Root CA Certificate ==="
openssl x509 -in "$CERT_DIR/root/root-ca.pem" -text -noout | head -20
echo "Thumbprint: $(openssl x509 -in "$CERT_DIR/root/root-ca.pem" -fingerprint -noout)"

# Generate intermediate CA key
openssl genrsa -aes256 -out "$CERT_DIR/intermediate/intermediate-ca.key" 4096

# Generate intermediate CA CSR
openssl req -new \
  -key "$CERT_DIR/intermediate/intermediate-ca.key" \
  -out "$CERT_DIR/intermediate/intermediate-ca.csr" \
  -subj "/CN=CSA IoT Intermediate CA 01/O=CSA-in-a-Box/OU=IoT Security/C=US/ST=Virginia"

# Sign intermediate CA with root CA (5-year lifetime)
openssl x509 -req -days 1825 \
  -in "$CERT_DIR/intermediate/intermediate-ca.csr" \
  -CA "$CERT_DIR/root/root-ca.pem" \
  -CAkey "$CERT_DIR/root/root-ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/intermediate/intermediate-ca.pem" \
  -extensions v3_intermediate_ca \
  -extfile <(cat <<EOF
[v3_intermediate_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always, issuer:always
EOF
)

# Create certificate chain file
cat "$CERT_DIR/intermediate/intermediate-ca.pem" \
    "$CERT_DIR/root/root-ca.pem" \
    > "$CERT_DIR/intermediate/chain.pem"

echo "=== Intermediate CA Certificate ==="
openssl x509 -in "$CERT_DIR/intermediate/intermediate-ca.pem" -text -noout | head -20

# Verify chain
openssl verify -CAfile "$CERT_DIR/root/root-ca.pem" \
  "$CERT_DIR/intermediate/intermediate-ca.pem"
# Expected: intermediate-ca.pem: OK
```

**Rollback point:** If certificate generation fails, no changes have been made to Azure. Simply regenerate.

---

## Step 2: Create DPS enrollment group (X.509)

Upload the intermediate CA to DPS and create an X.509 enrollment group.

```bash
# Upload and verify intermediate CA certificate in DPS
az iot dps certificate create \
  --dps-name "$DPS_NAME" \
  --resource-group "$RG" \
  --certificate-name "csa-iot-intermediate-ca-01" \
  --path "$CERT_DIR/intermediate/intermediate-ca.pem" \
  --verified true

echo "Certificate uploaded and verified in DPS."

# Create X.509 enrollment group
az iot dps enrollment-group create \
  --dps-name "$DPS_NAME" \
  --resource-group "$RG" \
  --enrollment-id "csa-fleet-x509" \
  --certificate-path "$CERT_DIR/intermediate/intermediate-ca.pem" \
  --provisioning-status enabled \
  --allocation-policy hashed \
  --iot-hubs "$IOT_HUB_HOSTNAME" \
  --initial-twin-properties '{
    "tags": {
      "authType": "x509",
      "migrationWave": "pilot",
      "migratedDate": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }
  }'

echo "X.509 enrollment group 'csa-fleet-x509' created."

# Verify enrollment group
az iot dps enrollment-group show \
  --dps-name "$DPS_NAME" -g "$RG" \
  --enrollment-id "csa-fleet-x509" \
  --query "{id:enrollmentGroupId, status:provisioningStatus, attestation:attestation.type}" \
  -o table
```

**Rollback point:** Delete enrollment group with `az iot dps enrollment-group delete --enrollment-id "csa-fleet-x509"`.

---

## Step 3: Generate device leaf certificates

Generate a unique certificate for each device in the pilot fleet.

```bash
#!/bin/bash
# generate-device-certs.sh
# Usage: ./generate-device-certs.sh <device-list-file>
# Device list file: one device ID per line

DEVICE_LIST="${1:-pilot-devices.txt}"
CERT_DIR="./certs/devices"
INTERMEDIATE_CA="./certs/intermediate/intermediate-ca.pem"
INTERMEDIATE_KEY="./certs/intermediate/intermediate-ca.key"

mkdir -p "$CERT_DIR"

while IFS= read -r DEVICE_ID; do
  [ -z "$DEVICE_ID" ] && continue
  echo "Generating certificate for: $DEVICE_ID"

  # Generate device private key (no encryption for automated use)
  openssl genrsa -out "$CERT_DIR/$DEVICE_ID.key" 2048 2>/dev/null

  # Generate CSR with device ID as CN
  openssl req -new \
    -key "$CERT_DIR/$DEVICE_ID.key" \
    -out "$CERT_DIR/$DEVICE_ID.csr" \
    -subj "/CN=$DEVICE_ID/O=CSA-in-a-Box/OU=IoT Devices/C=US" 2>/dev/null

  # Sign with intermediate CA (90-day lifetime)
  openssl x509 -req -days 90 \
    -in "$CERT_DIR/$DEVICE_ID.csr" \
    -CA "$INTERMEDIATE_CA" \
    -CAkey "$INTERMEDIATE_KEY" \
    -CAcreateserial \
    -out "$CERT_DIR/$DEVICE_ID.pem" \
    -extensions v3_device \
    -extfile <(cat <<EOF
[v3_device]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always, issuer:always
EOF
) 2>/dev/null

  # Create full chain (leaf + intermediate)
  cat "$CERT_DIR/$DEVICE_ID.pem" "$INTERMEDIATE_CA" > "$CERT_DIR/$DEVICE_ID-fullchain.pem"

  # Verify
  openssl verify -CAfile "$INTERMEDIATE_CA" "$CERT_DIR/$DEVICE_ID.pem" 2>/dev/null

  # Clean up CSR
  rm -f "$CERT_DIR/$DEVICE_ID.csr"

done < "$DEVICE_LIST"

echo "=== Certificate generation complete ==="
echo "Certificates: $(ls "$CERT_DIR"/*.pem 2>/dev/null | wc -l) files"
```

Create a pilot device list:

```bash
# Create pilot device list (first 10% of fleet)
az iot hub device-identity list \
  --hub-name "$IOT_HUB" \
  --query "[].deviceId" -o tsv | head -10 > pilot-devices.txt

echo "Pilot devices:"
cat pilot-devices.txt

# Generate certificates
chmod +x generate-device-certs.sh
./generate-device-certs.sh pilot-devices.txt
```

**Rollback point:** Certificates are generated locally. No Azure changes. Delete `$CERT_DIR/devices/` to start over.

---

## Step 4: Update device firmware/software

Update the device application to use X.509 certificate authentication instead of SAS.

### Python device client

```python
"""
iot_device_x509.py
IoT device client using X.509 certificate authentication.
Drop-in replacement for SAS-based device client.
"""

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from azure.iot.device.aio import IoTHubDeviceClient, ProvisioningDeviceClient
from azure.iot.device import X509, Message

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("iot-device")

# Configuration (environment variables or config file)
DPS_HOST = os.getenv("DPS_HOST", "global.azure-devices-provisioning.net")
DPS_ID_SCOPE = os.getenv("DPS_ID_SCOPE")
DEVICE_ID = os.getenv("DEVICE_ID")
CERT_PATH = os.getenv("CERT_PATH", f"/etc/iot-certs/{DEVICE_ID}.pem")
KEY_PATH = os.getenv("KEY_PATH", f"/etc/iot-certs/{DEVICE_ID}.key")
TELEMETRY_INTERVAL = int(os.getenv("TELEMETRY_INTERVAL", "60"))


async def provision_device():
    """Register device through DPS using X.509 certificate."""
    log.info(f"Provisioning device '{DEVICE_ID}' through DPS...")

    x509 = X509(cert_file=CERT_PATH, key_file=KEY_PATH)

    provisioning_client = ProvisioningDeviceClient.create_from_x509_certificate(
        provisioning_host=DPS_HOST,
        registration_id=DEVICE_ID,
        id_scope=DPS_ID_SCOPE,
        x509=x509,
    )

    result = await provisioning_client.register()

    if result.status == "assigned":
        log.info(f"Device provisioned to hub: {result.registration_state.assigned_hub}")
        return result.registration_state.assigned_hub
    else:
        log.error(f"Provisioning failed: {result.status}")
        sys.exit(1)


async def run_device(hub_hostname):
    """Connect to IoT Hub and send telemetry."""
    x509 = X509(cert_file=CERT_PATH, key_file=KEY_PATH)

    client = IoTHubDeviceClient.create_from_x509_certificate(
        hostname=hub_hostname,
        device_id=DEVICE_ID,
        x509=x509,
    )

    await client.connect()
    log.info(f"Connected to IoT Hub ({hub_hostname}) with X.509 certificate.")

    try:
        while True:
            telemetry = {
                "deviceId": DEVICE_ID,
                "temperature": 22.5,  # Replace with actual sensor reading
                "humidity": 45.0,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "authType": "x509",
            }

            message = Message(json.dumps(telemetry))
            message.content_type = "application/json"
            message.content_encoding = "utf-8"

            await client.send_message(message)
            log.info(f"Telemetry sent: temp={telemetry['temperature']}")

            await asyncio.sleep(TELEMETRY_INTERVAL)

    except KeyboardInterrupt:
        log.info("Shutting down...")
    finally:
        await client.disconnect()
        log.info("Disconnected.")


async def main():
    hub_hostname = await provision_device()
    await run_device(hub_hostname)


if __name__ == "__main__":
    asyncio.run(main())
```

### Deploy to devices

```bash
# Deploy updated software and certificates to pilot devices
while IFS= read -r DEVICE_ID; do
  IP=$(get_device_ip "$DEVICE_ID")  # Your device inventory lookup
  echo "Deploying to $DEVICE_ID ($IP)..."

  # Copy certificate and key
  scp "$CERT_DIR/devices/$DEVICE_ID.pem" "iot@$IP:/etc/iot-certs/$DEVICE_ID.pem"
  scp "$CERT_DIR/devices/$DEVICE_ID.key" "iot@$IP:/etc/iot-certs/$DEVICE_ID.key"

  # Copy updated device application
  scp iot_device_x509.py "iot@$IP:/opt/iot-agent/iot_device_x509.py"

  # Set permissions and restart
  ssh "iot@$IP" "chmod 644 /etc/iot-certs/$DEVICE_ID.pem && \
                  chmod 600 /etc/iot-certs/$DEVICE_ID.key && \
                  export DEVICE_ID=$DEVICE_ID && \
                  export DPS_ID_SCOPE=$DPS_ID_SCOPE && \
                  systemctl restart iot-device-agent"

  echo "  Done."
done < pilot-devices.txt
```

**Rollback point:** Revert device software to SAS version. Restart device agent. Device will reconnect using SAS.

---

## Step 5: Test provisioning (single device)

Test with a single device before rolling out to the fleet.

```bash
# Test single device provisioning
DEVICE_ID=$(head -1 pilot-devices.txt)
echo "Testing device: $DEVICE_ID"

# Run the device client locally (for testing)
DPS_ID_SCOPE="$DPS_ID_SCOPE" \
DEVICE_ID="$DEVICE_ID" \
CERT_PATH="$CERT_DIR/devices/$DEVICE_ID.pem" \
KEY_PATH="$CERT_DIR/devices/$DEVICE_ID.key" \
python iot_device_x509.py &

DEVICE_PID=$!
sleep 30

# Verify device registered in IoT Hub
az iot hub device-identity show \
  --hub-name "$IOT_HUB" \
  --device-id "$DEVICE_ID" \
  --query "{deviceId:deviceId, authType:authentication.type, status:status}" \
  -o table

# Verify telemetry is flowing
az iot hub monitor-events \
  --hub-name "$IOT_HUB" \
  --device-id "$DEVICE_ID" \
  --timeout 30 \
  --output table

# Stop test device
kill $DEVICE_PID
echo "Test complete."
```

**Rollback point:** Delete the X.509 device identity from IoT Hub. The device will fall back to SAS on next restart.

---

## Step 6: Rolling fleet migration (batch approach)

Migrate the remaining fleet in batches, monitoring each batch before proceeding.

```bash
#!/bin/bash
# rolling-migration.sh
# Migrate device fleet in waves: 10% -> 50% -> 100%

FLEET_FILE="all-devices.txt"
TOTAL=$(wc -l < "$FLEET_FILE")

# Wave 1: 10% (already done as pilot)
WAVE1_END=$((TOTAL / 10))
echo "=== Wave 1: Devices 1-$WAVE1_END (pilot - already migrated) ==="

# Wave 2: Next 40%
WAVE2_START=$((WAVE1_END + 1))
WAVE2_END=$((TOTAL / 2))
echo "=== Wave 2: Devices $WAVE2_START-$WAVE2_END ==="
sed -n "${WAVE2_START},${WAVE2_END}p" "$FLEET_FILE" > wave2-devices.txt
./generate-device-certs.sh wave2-devices.txt
# Deploy certificates and updated software to wave 2 devices
# ... (same deployment process as step 4)

# Monitor wave 2 for 2 hours before proceeding
echo "Monitoring wave 2... Check dashboard for errors."
echo "Press Enter to proceed to wave 3, or Ctrl+C to stop."
read -r

# Wave 3: Remaining 50%
WAVE3_START=$((WAVE2_END + 1))
echo "=== Wave 3: Devices $WAVE3_START-$TOTAL ==="
sed -n "${WAVE3_START},${TOTAL}p" "$FLEET_FILE" > wave3-devices.txt
./generate-device-certs.sh wave3-devices.txt
# Deploy certificates and updated software to wave 3 devices
# ... (same deployment process as step 4)

echo "All waves complete. Verify all devices in dashboard."
```

**Rollback point:** If a wave encounters issues, stop the migration. Devices already migrated continue working with X.509. Remaining devices continue working with SAS.

---

## Step 7: Verify all devices on new auth

```bash
# Count devices by authentication type
echo "=== Authentication Type Summary ==="
az iot hub device-identity list \
  --hub-name "$IOT_HUB" \
  --query "[].{deviceId:deviceId, authType:authentication.type}" \
  -o json | python3 -c "
import json, sys
devices = json.load(sys.stdin)
types = {}
for d in devices:
    t = d['authType']
    types[t] = types.get(t, 0) + 1
for t, c in sorted(types.items()):
    print(f'  {t}: {c} devices')
print(f'  Total: {len(devices)} devices')
"

# Verify no SAS connections in the last 24 hours
echo ""
echo "=== Recent SAS Connections (should be 0) ==="
az monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_WORKSPACE_ID" \
  --analytics-query "
    AzureDiagnostics
    | where ResourceProvider == 'MICROSOFT.DEVICES'
    | where Category == 'Connections'
    | where TimeGenerated > ago(24h)
    | where authType_s == 'sas'
    | summarize count()
  " -o table
```

---

## Step 8: Disable SAS policies

Once all devices are confirmed on X.509, disable SAS authentication on the IoT Hub.

```bash
# IMPORTANT: Verify ALL devices are on X.509 BEFORE this step
echo "Disabling SAS authentication on IoT Hub..."

# Disable local auth (SAS)
az iot hub update \
  --name "$IOT_HUB" \
  --resource-group "$RG" \
  --set properties.disableLocalAuth=true

# Clear shared access policies
az iot hub update \
  --name "$IOT_HUB" \
  --resource-group "$RG" \
  --set properties.authorizationPolicies='[]'

# Verify
echo "disableLocalAuth: $(az iot hub show -g "$RG" -n "$IOT_HUB" \
  --query properties.disableLocalAuth -o tsv)"
echo "authorizationPolicies: $(az iot hub show -g "$RG" -n "$IOT_HUB" \
  --query 'properties.authorizationPolicies' -o tsv)"

# Verify SAS connection attempts fail
echo ""
echo "Test: SAS connection should fail with 401..."
# This should fail:
az iot hub generate-sas-token --hub-name "$IOT_HUB" 2>&1 || echo "Expected: SAS token generation failed (local auth disabled)"
```

**Rollback point (NOT recommended for compliance):** Re-enable SAS with `az iot hub update --set properties.disableLocalAuth=false`. See the [original migration guide](../iot-hub-entra.md#rollback-not-recommended--exits-fedramp-path) for full rollback procedure.

---

## Step 9: Update Bicep template

Update the infrastructure-as-code template to enforce the new authentication posture for all future deployments.

```bicep
// Updated IoT Hub Bicep template (CSA-0025 compliant)
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
    disableLocalAuth: true
    authorizationPolicies: []
    routing: {
      endpoints: {
        eventHubs: [
          {
            name: 'telemetry'
            authenticationType: 'identityBased'
            endpointUri: 'sb://${eventHubNamespaceName}.servicebus.windows.net'
            entityPath: eventHubName
          }
        ]
      }
    }
  }
}
```

Commit and push the updated template:

```bash
# Update the Bicep template
# (Edit examples/iot-streaming/deploy/bicep/iot-hub.bicep as shown above)

# Verify the template deploys correctly
az deployment group what-if \
  --resource-group "$RG" \
  --template-file examples/iot-streaming/deploy/bicep/iot-hub.bicep \
  --parameters iotHubName="$IOT_HUB"
```

---

## Verification checklist

After completing all steps:

- [ ] Root CA certificate generated and stored offline
- [ ] Intermediate CA certificate generated and uploaded to DPS
- [ ] X.509 enrollment group created and active
- [ ] All devices have unique leaf certificates
- [ ] All devices successfully provisioning through DPS with X.509
- [ ] Telemetry flowing from all devices
- [ ] `disableLocalAuth: true` on IoT Hub
- [ ] `authorizationPolicies: []` on IoT Hub
- [ ] No SAS connections in logs for 24+ hours
- [ ] Monitoring alerts configured (see [Monitoring Migration](monitoring-migration.md))
- [ ] Bicep template updated and committed
- [ ] Old SAS enrollment group disabled (delete after 30-day soak)
- [ ] Key Vault no longer contains IoT Hub SAS keys

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [X.509 Migration Guide](x509-migration.md) | [DPS Migration](dps-migration.md) | [Monitoring](monitoring-migration.md)
