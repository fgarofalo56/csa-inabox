# Best Practices — SAS to Entra Migration

**Phased rollout strategy, certificate management, HSM guidance, rollback planning, common pitfalls, and post-migration hardening.**

> **Finding:** CSA-0025 (HIGH, BREAKING) | **Ballot:** AQ-0014 (approved)

---

## Phased rollout strategy

### Why phased

A SAS-to-Entra migration is a breaking change. Devices using SAS keys will fail to authenticate once `disableLocalAuth: true` is set. A phased rollout limits the blast radius of any issue and provides natural validation gates.

### Recommended phases

```
Phase 0: Preparation (Week 1-2)
├── Certificate infrastructure setup
├── Monitoring baseline established
├── Runbook created and tested
└── Rollback procedure validated

Phase 1: Pilot (Week 3)
├── 10% of device fleet migrated to X.509
├── 1 backend service migrated to managed identity
├── 48-hour soak test
└── Gate: Zero auth failures, telemetry flowing

Phase 2: Early Majority (Week 4-5)
├── 50% of device fleet migrated
├── All backend services migrated to managed identity
├── 1-week soak test
└── Gate: < 0.1% error rate, all monitoring alerts clean

Phase 3: Full Rollout (Week 6-7)
├── 100% of device fleet migrated
├── SAS enrollment groups disabled (not deleted)
├── 1-week soak test
└── Gate: Zero SAS connections in logs

Phase 4: Cutover (Week 8)
├── disableLocalAuth: true on IoT Hub
├── authorizationPolicies: [] on IoT Hub
├── SAS enrollment groups deleted
├── Bicep template updated
└── Gate: Compliance scan passes
```

### Phase gate criteria

| Gate | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|---|---|---|---|---|
| X.509 connection success rate | > 99% | > 99.9% | > 99.9% | > 99.9% |
| Managed identity auth failures | 0 | < 5 per day | < 5 per day | < 5 per day |
| SAS connections remaining | < 90% of fleet | < 50% of fleet | 0 | N/A (disabled) |
| Certificate-related incidents | 0 critical | 0 critical | 0 critical | 0 |
| Monitoring coverage | Basic | Full dashboard | Full + alerts | Full + audited |
| Rollback tested | Yes | Yes | Yes | N/A |

---

## Certificate management

### Azure Key Vault integration

Azure Key Vault should be the central certificate management system for intermediate CA certificates and service certificates.

```bash
# Import intermediate CA to Key Vault
az keyvault certificate import \
  --vault-name "$KV_NAME" \
  --name "iot-intermediate-ca-01" \
  --file intermediate-ca.pfx \
  --password "$PFX_PASSWORD"

# Enable auto-renewal for service certificates
az keyvault certificate set-attributes \
  --vault-name "$KV_NAME" \
  --name "iot-intermediate-ca-01" \
  --policy '{
    "issuer_parameters": {"name": "Self"},
    "key_properties": {"exportable": true, "key_size": 4096, "key_type": "RSA"},
    "lifetime_actions": [
      {
        "action": {"action_type": "AutoRenew"},
        "trigger": {"days_before_expiry": 90}
      },
      {
        "action": {"action_type": "EmailContacts"},
        "trigger": {"days_before_expiry": 120}
      }
    ],
    "x509_certificate_properties": {
      "validity_in_months": 60,
      "subject": "CN=CSA IoT Intermediate CA 01,O=CSA-in-a-Box,C=US"
    }
  }'
```

### Certificate lifecycle policy

| Certificate type | Lifetime | Renewal trigger | Storage | Renewal method |
|---|---|---|---|---|
| Root CA | 10-20 years | Manual (5 years before expiry) | Offline HSM | Manual ceremony |
| Intermediate CA | 2-5 years | 90 days before expiry | Azure Key Vault (HSM-backed) | Key Vault auto-renewal |
| Device leaf | 90-365 days | 30 days before expiry | Device HSM/TPM | DPS re-provisioning |
| Service certificates | 1-2 years | 30 days before expiry | Azure Key Vault | Key Vault auto-renewal |

### Certificate revocation

Maintain a Certificate Revocation List (CRL) for compromised device certificates.

```bash
# CRL distribution setup
# 1. Create storage account for CRL
az storage account create \
  --name "stiotcrl" \
  --resource-group "$RG" \
  --sku Standard_LRS \
  --kind StorageV2

# 2. Create container with public blob access (CRL must be publicly readable)
az storage container create \
  --account-name "stiotcrl" \
  --name "crl" \
  --public-access blob

# 3. Generate and upload CRL
openssl ca -gencrl \
  -keyfile intermediate-ca.key \
  -cert intermediate-ca.pem \
  -out crl.pem \
  -config openssl.cnf

az storage blob upload \
  --account-name "stiotcrl" \
  --container-name "crl" \
  --file crl.pem \
  --name "iot-intermediate-ca-01.crl" \
  --overwrite

# 4. Set up CDN for low-latency CRL distribution (optional)
az cdn endpoint create \
  --name "cdn-iot-crl" \
  --profile-name "cdn-iot" \
  --resource-group "$RG" \
  --origin "stiotcrl.blob.core.windows.net" \
  --origin-path "/crl"
```

---

## HSM for high-security environments

### When HSM is required

| Environment | HSM requirement | Recommended HSM |
|---|---|---|
| DoD IL5 | Required (FIPS 140-2 Level 2+) | Azure Managed HSM + device TPM |
| DoD IL6 | Required (FIPS 140-2 Level 3) | Azure Dedicated HSM + device SE |
| FedRAMP High | Strongly recommended | Azure Key Vault Premium (FIPS 140-2 L2) |
| FedRAMP Moderate | Recommended | Azure Key Vault Standard |
| CMMC Level 3 | Required for CUI | Device TPM 2.0 |
| Commercial high-security | Recommended | Device TPM or secure element |

### HSM architecture

```
Cloud Side:
  Azure Managed HSM
  ├── Root CA private key (never exported)
  ├── Intermediate CA private key (signing operations only)
  └── FIPS 140-2 Level 3 validated

Device Side:
  TPM 2.0 / Secure Element
  ├── Device private key (generated in HSM, never exported)
  ├── Certificate stored in NV RAM
  └── TLS signing operations performed inside HSM
```

### Key Vault Premium vs Managed HSM

| Feature | Key Vault Premium | Managed HSM |
|---|---|---|
| FIPS 140-2 | Level 2 | Level 3 |
| HSM type | Multi-tenant | Single-tenant |
| Key sovereignty | Microsoft-managed | Customer-managed |
| Pricing | Per operation | Per HSM unit/hour |
| Use case | Most federal workloads | Highest sensitivity (IL6, ITAR) |
| Backup/restore | Microsoft-managed | Customer-managed (bring-your-own-key) |

---

## Monitoring during migration window

### Critical monitoring during each phase

| Monitor | Alert threshold | Action |
|---|---|---|
| X.509 connection failures | > 5 per 15 min | Pause migration, investigate certificate chain |
| Managed identity auth failures | > 0 | Check RBAC assignment, IMDS endpoint health |
| SAS connections from migrated devices | > 0 | Device software not updated correctly |
| DPS registration failures | > 5 per hour | Check enrollment group, CA certificate |
| Certificate expiry < 7 days | Any | Emergency certificate renewal |
| IoT Hub throttling | > 10 per minute | Scale IoT Hub or reduce migration batch size |

### Dashboard during migration

Keep the following KQL queries pinned during the migration window:

```kql
// Real-time migration progress
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where TimeGenerated > ago(1h)
| summarize
    X509 = dcountif(deviceId_s, authType_s == "x509"),
    SAS = dcountif(deviceId_s, authType_s == "sas"),
    Total = dcount(deviceId_s)
    by bin(TimeGenerated, 5m)
| extend PercentMigrated = round(100.0 * X509 / Total, 1)
| project TimeGenerated, X509, SAS, PercentMigrated
| render timechart
```

---

## Rollback planning

### Rollback strategy: Keep SAS capability until 100% migrated

**Critical rule:** Do not set `disableLocalAuth: true` until every device and service has been verified on Entra authentication. SAS and Entra authentication can coexist -- use this to your advantage.

### Rollback by phase

| Phase | Rollback action | Data loss risk | Time to rollback |
|---|---|---|---|
| Phase 1 (pilot) | Revert device software, delete X.509 device identities | None | < 1 hour |
| Phase 2 (50%) | Revert device software in batches | None | 2-4 hours |
| Phase 3 (100%) | Re-enable SAS enrollment group, revert device software | None | 4-8 hours |
| Phase 4 (cutover) | Set `disableLocalAuth: false`, restore SAS policies | None, but exits compliance path | 15 minutes |

### Rollback procedure (post-cutover)

```bash
# EMERGENCY ROLLBACK (Phase 4)
# WARNING: This exits the FedRAMP High / IL5 compliance path.
# Document the exception per your SSP.

# 1. Re-enable SAS authentication
az iot hub update \
  --name "$IOT_HUB" -g "$RG" \
  --set properties.disableLocalAuth=false

# 2. Wait for change to propagate (< 1 minute)
sleep 60

# 3. Verify SAS is re-enabled
az iot hub show -g "$RG" -n "$IOT_HUB" \
  --query properties.disableLocalAuth -o tsv
# Expected: false

# 4. Default shared access policies are automatically recreated
# Verify:
az iot hub show -g "$RG" -n "$IOT_HUB" \
  --query properties.authorizationPolicies -o table

# 5. Generate new connection strings for services that need them
# (Old connection strings are no longer valid -- new keys were generated)

# 6. File compliance exception referencing CSA-0025
# Plan re-migration with hard deadline
```

---

## Common pitfalls

### 1. Not testing certificate chain validation before fleet rollout

**Problem:** Device certificates work in testing (self-signed or simplified chain) but fail in production because the full certificate chain is not properly configured.

**How it manifests:** Devices return `401 Unauthorized` or TLS handshake failure during DPS registration.

**Prevention:**
```bash
# Always verify the complete chain before deployment
openssl verify -CAfile chain.pem device-cert.pem
# Expected: device-cert.pem: OK

# Verify the chain includes all intermediate certificates
openssl crl2pkcs7 -nocrl -certfile chain.pem | openssl pkcs7 -print_certs -noout
# Should show Root CA and Intermediate CA subjects
```

### 2. Forgetting to update all backend services before disabling SAS

**Problem:** One or more backend services still use SAS connection strings when `disableLocalAuth: true` is set. Those services silently fail.

**How it manifests:** Backend Functions stop processing telemetry. Device twin updates stop. Alerts stop firing. Failures may not be immediately obvious if error handling swallows the 401 response.

**Prevention:**
```bash
# Comprehensive scan for SAS connection strings BEFORE cutover
for FUNC in $(az functionapp list -g "$RG" --query "[].name" -o tsv); do
  az functionapp config appsettings list -g "$RG" -n "$FUNC" \
    --query "[?contains(value || '', 'SharedAccessKey')].{name:name, app:'$FUNC'}" -o table
done

# Check Key Vault for remaining SAS secrets
az keyvault secret list --vault-name "$KV_NAME" \
  --query "[?contains(name, 'iothub') || contains(name, 'SharedAccessKey')].name" -o tsv
```

### 3. Certificate expiration causing fleet-wide outage

**Problem:** All device certificates were generated at the same time with the same expiry date. When they expire, the entire fleet goes offline simultaneously.

**How it manifests:** Sudden, total loss of device connectivity on a specific date.

**Prevention:**
- Stagger certificate generation across the fleet (add random jitter to expiry dates)
- Set certificate renewal to trigger 30 days before expiry
- Configure monitoring alerts for certificates expiring within 30 days
- Use different intermediate CAs for different fleet segments (independent renewal cycles)

```bash
# Generate certificates with staggered expiry (example: 80-100 day range)
for DEVICE in $(cat device-list.txt); do
  JITTER=$((RANDOM % 20 + 80))  # 80-100 days
  openssl x509 -req -days $JITTER \
    -in "$DEVICE.csr" \
    -CA intermediate-ca.pem -CAkey intermediate-ca.key \
    -CAcreateserial -out "$DEVICE.pem"
done
```

### 4. Not accounting for offline device scenarios

**Problem:** Some devices are offline during the migration window. When they reconnect, they still use SAS keys, but SAS is now disabled.

**How it manifests:** Devices that were offline during migration cannot connect. They may be in remote locations with no easy access for firmware updates.

**Prevention:**
- Inventory all devices and their connectivity patterns
- Identify devices with infrequent connectivity (weekly, monthly)
- Extend the migration window to cover the longest offline period
- Do not disable SAS until ALL devices (including offline ones) have reconnected with X.509
- Consider a "phone home" mechanism where devices check for firmware updates on connection

```kql
// Identify devices that have not connected recently
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where TimeGenerated > ago(90d)
| summarize LastSeen = max(TimeGenerated) by deviceId_s
| where LastSeen < ago(7d)
| order by LastSeen asc
```

### 5. Using RSA 2048 on resource-constrained devices

**Problem:** RSA 2048 key operations are computationally expensive on microcontrollers (ESP32, STM32, etc.), causing connection timeouts or excessive battery drain.

**Prevention:** Use ECC P-256 for constrained devices. It provides equivalent security with significantly lower computational cost.

### 6. Not handling RBAC propagation delay

**Problem:** RBAC role assignment is created, but the service immediately tries to authenticate. The role has not propagated yet, causing a transient 403 error.

**Prevention:** Wait 30-60 seconds after RBAC assignment before testing. In CI/CD pipelines, add an explicit wait step.

```bash
# RBAC assignment
az role assignment create --assignee "$PRINCIPAL_ID" --role "IoT Hub Data Contributor" --scope "$IOT_HUB_ID"

# Wait for propagation
echo "Waiting 60 seconds for RBAC propagation..."
sleep 60

# Then test
az rest --method get --url "https://$IOT_HUB_HOSTNAME/twins/test-device?api-version=2021-04-12" 2>/dev/null
```

---

## Post-migration hardening checklist

After the migration is complete and stable (30-day soak period), perform these hardening steps:

### Authentication hardening

- [ ] `disableLocalAuth: true` confirmed on IoT Hub
- [ ] `authorizationPolicies: []` confirmed (no SAS policies)
- [ ] All SAS enrollment groups deleted from DPS
- [ ] All SAS connection string secrets purged from Key Vault (not just soft-deleted)
- [ ] No SAS connection strings in any app settings, environment variables, or config files
- [ ] CI/CD pipeline outputs do not contain SAS key material
- [ ] ARM deployment history does not contain SAS keys (consider purging old deployments)

### Certificate hardening

- [ ] Root CA private key stored offline in HSM (not on any connected system)
- [ ] Intermediate CA private key in Azure Key Vault Premium or Managed HSM
- [ ] Device private keys in HSM/TPM (for IL5+) or encrypted storage
- [ ] Certificate lifetimes comply with organizational policy (typically 90 days for devices)
- [ ] Auto-renewal configured for all certificates
- [ ] CRL distribution point configured and tested
- [ ] Certificate expiration alerts configured (7, 14, and 30 day warnings)

### RBAC hardening

- [ ] Each service has the minimum RBAC role required (least privilege review)
- [ ] No service has `iothubowner`-equivalent access unless justified
- [ ] RBAC assignments documented in Bicep/Terraform (not ad-hoc CLI assignments)
- [ ] Quarterly access review scheduled for IoT Hub RBAC assignments
- [ ] PIM (Privileged Identity Management) enabled for administrative access

### Monitoring hardening

- [ ] Alert rule: SAS authentication attempts (should always fire 0)
- [ ] Alert rule: Certificate expiration warnings
- [ ] Alert rule: Authentication failure spikes
- [ ] Alert rule: Managed identity failures
- [ ] Dashboard: Auth type distribution (should show 100% X.509 / managed identity)
- [ ] Log retention: 90+ days for connection logs, 180+ days for audit logs
- [ ] SIEM integration: IoT Hub and Entra logs flowing to security operations center

### Documentation hardening

- [ ] Bicep/Terraform templates updated with Entra-only configuration
- [ ] Deployment runbook updated (no SAS key references)
- [ ] Incident response plan updated for certificate-related incidents
- [ ] SSP (System Security Plan) updated with new authentication posture
- [ ] ATO package updated with resolved findings for IA-2, IA-5, AU-2, SC-8
- [ ] Team trained on certificate management and managed identity debugging

---

## Migration success criteria

Define these criteria before starting and validate after completion:

| Criterion | Target | Measurement |
|---|---|---|
| Device auth migration | 100% on X.509 | IoT Hub connection logs |
| Service auth migration | 100% on managed identity | Entra sign-in logs |
| SAS keys in circulation | 0 | Key Vault audit + app settings scan |
| Auth failure rate | < 0.01% | Monitoring dashboard |
| Certificate renewal success rate | 100% | Certificate monitoring alerts |
| NIST 800-53 controls satisfied | 15+ controls | Control assessment report |
| Zero Trust maturity | Advanced or Optimal (Identity pillar) | CISA maturity assessment |
| Compliance findings resolved | CSA-0025 closed | Finding tracker |
| Rollback capability tested | Yes (pre-cutover) | Test documentation |
| Team operational readiness | Certificate + MI debugging trained | Training records |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Monitoring](monitoring-migration.md) | [Original Migration Guide](../iot-hub-entra.md)
