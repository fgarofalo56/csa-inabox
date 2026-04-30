# Why Entra ID over SAS Keys for IoT Hub

**An executive brief for CISOs, Authorizing Officials, and federal security architects evaluating IoT Hub authentication posture.**

> **Finding:** CSA-0025 (HIGH, BREAKING) | **Ballot:** AQ-0014 (approved)
> **Requirement:** FedRAMP High / DoD IL5 baseline compliance

---

## Executive summary

Azure IoT Hub and Device Provisioning Service (DPS) have historically supported Shared Access Signature (SAS) key authentication -- a model built on static shared secrets. While SAS keys were adequate for early IoT deployments, they fail to meet modern federal security requirements under FedRAMP High, DoD IL5, and the Zero Trust Architecture mandated by Executive Order 14028.

Migrating from SAS keys to Entra ID-based authentication (X.509 certificates for devices, managed identities for services) eliminates the largest category of IoT credential compromise risk, satisfies 15+ NIST 800-53 controls, and aligns your IoT platform with the same identity fabric governing every other Azure workload.

This document presents the strategic and security case for this migration.

---

## The SAS key problem

### Static shared secrets

SAS keys are long-lived, symmetric secrets. Unlike certificates or tokens, they do not expire on a schedule unless you manually rotate them. The typical federal IoT deployment has SAS keys that have not been rotated since initial provisioning -- creating a compromise window measured in months or years.

```
SAS Key Lifecycle (typical):
  Created ─────────────────────────────────────────── Compromised?
  Day 0                                                Day 365+
  │                                                    │
  └── No automatic expiration                          │
  └── No rotation enforcement                          │
  └── No compromise detection                     ────►│
```

### Key material in deployment history

The CSA-in-a-Box template previously called `iotHub.listKeys()` inline to build the DPS connection string and Key Vault secrets. This pattern writes SAS key material to:

- **ARM deployment history** (readable by anyone with `Microsoft.Resources/deployments/read`)
- **Azure Activity Log** (retained 90 days by default)
- **Linked deployment output payloads** (visible to orchestrating templates)
- **CI/CD pipeline logs** (if deployment outputs are logged)

This means the primary key was available to a broader audience than intended, for longer than intended, with no audit trail of who read it.

### Rotation burden

Rotating a SAS key requires:

1. Generate new key on IoT Hub
2. Update every device using the old key (potentially thousands)
3. Update every backend service using the connection string
4. Update Key Vault secrets
5. Verify all components reconnected
6. Revoke the old key

This process is manual, error-prone, and typically takes days to weeks for large fleets. During rotation, both old and new keys are valid -- doubling the attack surface.

### No per-identity attribution

SAS keys authenticate a **policy**, not an **identity**. When a service connects using the `iothubowner` shared access policy, IoT Hub logs show the policy name, not which specific service, user, or pipeline invoked the operation. This makes forensic investigation after an incident substantially harder.

---

## Zero Trust alignment

### NIST 800-207 (Zero Trust Architecture)

Executive Order 14028 (May 2021) mandates federal agencies adopt Zero Trust principles. NIST 800-207 defines Zero Trust through several tenets. SAS keys violate the most fundamental ones:

| Zero Trust tenet | SAS keys | Entra ID |
|---|---|---|
| All data sources and computing services are considered resources | SAS treats IoT Hub as a single trust boundary | Entra scopes access per resource, per identity |
| All communication is secured regardless of network location | SAS keys provide authentication but identical access regardless of caller context | Entra supports Conditional Access, device compliance, network location policies |
| Access is granted on a per-session basis | SAS tokens can have long lifetimes (hours to days) | Managed identity tokens expire in 1 hour; certificate auth uses TLS session-level handshakes |
| Access is determined by dynamic policy | SAS policies are static (read, write, connect, manage) | Entra RBAC roles are granular and dynamically assignable |
| The enterprise monitors and measures integrity and security posture | SAS provides minimal audit signal | Entra provides full sign-in logs, Conditional Access evaluation logs, and risk-based detection |
| Authentication and authorization are dynamic and strictly enforced | SAS has no concept of risk-based access or step-up authentication | Entra integrates with Identity Protection, risk scoring, and Conditional Access |

### CISA Zero Trust Maturity Model

The CISA Zero Trust Maturity Model (v2.0) evaluates agencies across five pillars. SAS key authentication places IoT Hub at the **Traditional** (lowest) maturity level for the Identity pillar. Migrating to Entra ID moves the deployment to **Advanced** or **Optimal** depending on implementation depth.

| Maturity level | Identity pillar requirement | SAS | Entra |
|---|---|---|---|
| Traditional | Password/shared secret authentication | Yes | N/A |
| Initial | MFA for human users | N/A | Yes (for admin access) |
| Advanced | Phishing-resistant MFA, automated lifecycle | No | Yes (certificate-based, managed identity) |
| Optimal | Continuous validation, risk-based access | No | Yes (Conditional Access, Identity Protection) |

---

## FedRAMP High requirements

FedRAMP High baseline requires 421 controls. SAS key authentication creates findings against multiple control families. The most critical:

### IA-2: Identification and Authentication (Organizational Users)

**Requirement:** The information system uniquely identifies and authenticates organizational users.

**SAS failure:** SAS shared access policies authenticate a policy name (`iothubowner`, `service`, `device`), not individual users or services. Multiple services sharing the same connection string are indistinguishable.

**Entra resolution:** Every managed identity, service principal, and user has a unique object ID. All authentication events are attributed to a specific identity.

### IA-5: Authenticator Management

**Requirement:** The organization manages information system authenticators by verifying identity before issuing, establishing minimum lifetime restrictions, and protecting authenticators from unauthorized disclosure.

**SAS failure:** SAS keys have no expiration policy. Rotation is manual. Keys are disclosed through deployment history. There is no mechanism to verify the identity of the entity receiving the key.

**Entra resolution:** Managed identity tokens expire in 1 hour and auto-rotate. X.509 certificates have configurable lifetimes with automated renewal through Key Vault. Certificate issuance follows a chain-of-trust validation.

### SC-8: Transmission Confidentiality and Integrity

**Requirement:** The information system protects the confidentiality and integrity of transmitted information.

**SAS concern:** SAS tokens are bearer tokens -- anyone who possesses the token string can authenticate. If intercepted (e.g., from logs), the token is immediately usable.

**Entra resolution:** X.509 authentication uses TLS mutual authentication. The private key never leaves the device. Managed identity tokens are bound to the Azure compute instance and cannot be replayed from a different source.

### AU-2: Audit Events

**Requirement:** The organization determines auditable events and ensures the information system generates audit records.

**SAS failure:** SAS authentication generates minimal audit signal. Policy-level access means individual service actions cannot be attributed.

**Entra resolution:** Every Entra authentication generates a sign-in log entry with: identity, timestamp, resource, result, IP address, device compliance state, Conditional Access policies evaluated, and risk level.

---

## DoD IL5 requirements

Impact Level 5 (IL5) in the DoD Cloud Computing Security Requirements Guide (CC SRG) requires all NIST 800-53 Rev 5 High baseline controls plus additional overlays. Key authentication requirements:

### IA controls

- **IA-2(6):** Access to privileged accounts requires multifactor authentication. SAS key access to `iothubowner` (which has full control-plane and data-plane access) does not satisfy this. Entra-managed access with Conditional Access and PIM does.

- **IA-2(12):** Identity must be verified using PIV credentials or an approved alternative. SAS keys are not PIV-compatible. Entra supports certificate-based authentication anchored to DoD PKI.

- **IA-5(2):** PKI-based authentication. SAS keys are symmetric secrets, not PKI-based. X.509 certificates with Entra satisfy this control directly.

### SC controls

- **SC-28:** Protection of information at rest. SAS keys stored in Key Vault are encrypted at rest, but the key material itself is a shared secret. Managed identities eliminate the need to store any credential material.

- **SC-13:** Cryptographic protection. FIPS 140-2 validated cryptography is required. Entra token issuance and X.509 certificate validation use FIPS-validated modules. SAS token HMAC-SHA256 computation may or may not use FIPS-validated modules depending on the SDK version and runtime.

---

## Credential lifecycle management

### SAS key lifecycle (manual)

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│ Generate key │────►│ Distribute  │────►│ Store in     │
│ (Azure CLI)  │     │ to N devices│     │ Key Vault /  │
│              │     │ + M services│     │ env vars /   │
│              │     │             │     │ config files │
└─────────────┘     └─────────────┘     └──────────────┘
       │                                        │
       │              ┌──────────────┐          │
       │              │ Manual       │          │
       └──────────────│ rotation     │◄─────────┘
                      │ (every 90d?) │
                      │ (never?)     │
                      └──────────────┘
```

**Problems:**
- No enforcement of rotation schedule
- Rotation requires coordinated downtime
- Old key remains valid until explicitly revoked
- No notification when key has not been rotated
- Key material copies proliferate across environments

### Entra credential lifecycle (automated)

```
Managed Identity Tokens:
  Auto-issued ──► 1-hour lifetime ──► Auto-renewed
  No human intervention. No storage. No rotation burden.

X.509 Certificates:
  CA issues ──► Configurable lifetime ──► Key Vault auto-renews
                                          ──► DPS re-provisions device
  Automated. Audited. Policy-enforced.
```

**Advantages:**
- Tokens auto-expire and auto-renew (managed identity)
- Certificate lifetimes are policy-enforced (30 days, 90 days, 1 year)
- Azure Key Vault automates certificate renewal
- DPS re-provisioning handles device certificate updates
- No shared secrets to distribute, store, or rotate

---

## Audit trail improvement

### SAS audit trail

```json
{
  "operationName": "DeviceConnect",
  "properties": {
    "protocol": "Mqtt",
    "authType": "sas",
    "policyName": "device",
    "statusCode": 200
  }
}
```

**What you know:** A device connected using the `device` SAS policy.
**What you do not know:** Which device. Which key. Where the request originated. Whether the credential was compromised.

### Entra audit trail

```json
{
  "operationName": "DeviceConnect",
  "properties": {
    "protocol": "Mqtt",
    "authType": "x509",
    "deviceId": "sensor-floor3-unit47",
    "certificateThumbprint": "A1B2C3...",
    "certificateExpiry": "2026-09-15T00:00:00Z",
    "statusCode": 200
  }
}
```

For service-level access:

```json
{
  "identity": {
    "principalId": "a1b2c3d4-...",
    "principalType": "ServicePrincipal",
    "displayName": "func-iot-processor"
  },
  "authorization": {
    "roleDefinitionId": "IoT Hub Data Contributor",
    "scope": "/subscriptions/.../Microsoft.Devices/IotHubs/hub-prod"
  },
  "resultType": "Success",
  "callerIpAddress": "10.0.1.50",
  "conditionalAccessPolicies": [
    { "displayName": "Require managed device", "result": "success" }
  ]
}
```

**What you know:** Exactly which identity authenticated, what role they used, from where, whether they met Conditional Access requirements, and the risk assessment.

---

## Compliance acceleration

Migrating from SAS to Entra directly satisfies or substantially advances the following NIST 800-53 Rev 5 controls:

| Control | Description | SAS status | Entra status |
|---|---|---|---|
| IA-2 | Identification and authentication | Partial (policy-level) | Full (identity-level) |
| IA-2(1) | MFA for privileged access | Not supported | Supported via Conditional Access |
| IA-2(6) | Access with separate device | Not supported | Supported via certificate + device |
| IA-2(12) | PIV credential acceptance | Not supported | Supported via CBA |
| IA-4 | Identifier management | Shared identifiers | Unique per identity |
| IA-5 | Authenticator management | Manual rotation | Automated lifecycle |
| IA-5(2) | PKI-based authentication | Not applicable | X.509 / certificate-based |
| IA-8 | Non-organizational user identification | Bearer token | Full identity verification |
| AU-2 | Audit events | Minimal | Comprehensive sign-in logs |
| AU-3 | Content of audit records | Policy name only | Full identity context |
| AU-6 | Audit review, analysis, and reporting | Limited signal | Rich signal for SIEM |
| AC-2 | Account management | N/A (no accounts) | Full lifecycle management |
| AC-3 | Access enforcement | Coarse (policy-level) | Granular (RBAC role-level) |
| AC-6 | Least privilege | 5 fixed policies | Custom RBAC roles |
| SC-8 | Transmission confidentiality | Bearer token risk | Mutual TLS / bound tokens |

This is 15 controls from a single migration. For a FedRAMP High authorization package, each of these controls requires an implementation statement. Migrating to Entra upgrades all 15 from "partially implemented" or "planned" to "fully implemented."

---

## Cost of a breach

### SAS key compromise scenario

A SAS key for the `iothubowner` policy is leaked through ARM deployment history.

**Impact:**
- Attacker can read/write all device twins (exfiltrate device configuration data)
- Attacker can invoke direct methods on any device (command injection)
- Attacker can create/delete device identities (denial of service)
- Attacker can read telemetry from the built-in endpoint (data exfiltration)
- **All of the above** using a single compromised string
- **No way to detect** the compromise through IoT Hub logs alone (legitimate policy name)
- **Blast radius:** Entire IoT Hub (all devices, all data)

**Recovery cost:**
- Rotate both keys on every shared access policy
- Update every device and service using those keys
- Audit all operations since the key was exposed (potentially months)
- File a breach notification (PII in device twins triggers breach notification requirements)
- Estimated cost: $500K-$2M+ for a large federal deployment

### Entra-managed identity compromise scenario

A managed identity token is somehow intercepted.

**Impact:**
- Token expires in 1 hour (automatic containment)
- Token is scoped to specific RBAC role (not full admin)
- Token is bound to the Azure compute instance (cannot be replayed from elsewhere in most configurations)
- **Blast radius:** Limited to the specific role assignment scope

**Recovery cost:**
- Revoke the managed identity (immediate, single API call)
- Review sign-in logs for the specific identity (minutes, not months)
- Scope is limited and fully auditable
- Estimated cost: $10K-$50K for investigation and response

---

## Decision framework

### When to migrate immediately

- Your deployment must achieve FedRAMP High authorization
- Your deployment handles DoD IL4/IL5/IL6 data
- You are subject to Executive Order 14028 Zero Trust requirements
- Your SAS keys have not been rotated in the past 90 days
- Your deployment history contains SAS key material
- You have had a security finding related to IoT Hub credential management

### When to plan migration within 6 months

- You are pursuing FedRAMP Moderate authorization
- Your organization has adopted a Zero Trust strategy
- You are expanding your IoT fleet and want to avoid accumulating SAS key technical debt
- Your security team has flagged SAS keys as a risk

### When this migration may not apply

- Development/sandbox environments with no production data (but consider migrating anyway to build operational muscle)
- IoT Hub instances with fewer than 10 devices and no compliance requirements (SAS may be acceptable with documented risk acceptance)

---

## Summary

| Dimension | SAS keys | Entra ID |
|---|---|---|
| Credential type | Static shared secret | Dynamic token / X.509 certificate |
| Expiration | Manual (or never) | Automatic (1 hour / configurable) |
| Rotation | Manual, disruptive | Automatic, seamless |
| Attribution | Policy-level | Identity-level |
| Audit signal | Minimal | Comprehensive |
| Blast radius | Entire IoT Hub | Scoped to RBAC assignment |
| FedRAMP High | Fails IA-2, IA-5, AU-2 | Satisfies all |
| IL5 | Fails IA-2(6), IA-5(2) | Satisfies all |
| Zero Trust | Traditional maturity | Advanced/Optimal maturity |
| Recovery cost | $500K-$2M+ | $10K-$50K |

The migration from SAS to Entra is not optional for federal IoT deployments. It is a foundational security improvement that closes the largest category of IoT credential risk.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Security Analysis](security-analysis.md) | [Original Migration Guide](../iot-hub-entra.md) | [Migration Center](index.md)
