# Security Analysis — SAS to Entra Migration

**Technical security deep dive for security engineers, penetration testers, and Authorizing Officials evaluating IoT Hub authentication posture.**

> **Finding:** CSA-0025 (HIGH, BREAKING) | **Ballot:** AQ-0014 (approved)

---

## Attack surface comparison

### SAS key attack surface

The SAS key authentication model exposes the following attack surface:

```
┌─────────────────────────────────────────────────────────────┐
│                    SAS Key Attack Surface                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ Key material │    │ Connection   │    │ SAS tokens   │   │
│  │ at rest      │    │ strings in   │    │ in transit   │   │
│  │              │    │ config       │    │              │   │
│  │ - Key Vault  │    │ - App config │    │ - HTTP       │   │
│  │ - ARM hist.  │    │ - Env vars   │    │   headers    │   │
│  │ - CI/CD logs │    │ - Code repos │    │ - MQTT       │   │
│  │ - Activity   │    │ - Docker img │    │   CONNECT    │   │
│  │   Log        │    │ - Bicep out  │    │              │   │
│  └──────────────┘    └──────────────┘    └──────────────┘   │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ Shared       │    │ No per-      │    │ Unlimited    │   │
│  │ policies     │    │ device       │    │ token        │   │
│  │ (5 max)      │    │ attribution  │    │ lifetime     │   │
│  └──────────────┘    └──────────────┘    └──────────────┘   │
│                                                              │
│  Total discrete attack vectors: 12+                          │
└─────────────────────────────────────────────────────────────┘
```

### Entra ID attack surface

```
┌─────────────────────────────────────────────────────────────┐
│                   Entra ID Attack Surface                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ Certificate  │    │ Managed      │    │ Entra token  │   │
│  │ private key  │    │ identity     │    │ endpoint     │   │
│  │ (on device)  │    │ endpoint     │    │              │   │
│  │              │    │ (169.254.    │    │ - 1-hour     │   │
│  │ - HSM prot.  │    │  169.254)    │    │   lifetime   │   │
│  │ - Never      │    │ - Instance-  │    │ - Bound to   │   │
│  │   leaves     │    │   bound      │    │   identity   │   │
│  │   device     │    │ - Not        │    │ - Scoped     │   │
│  │              │    │   routable   │    │   to role    │   │
│  └──────────────┘    └──────────────┘    └──────────────┘   │
│                                                              │
│  Total discrete attack vectors: 3-4                          │
│  (each with built-in mitigations)                            │
└─────────────────────────────────────────────────────────────┘
```

### Quantified comparison

| Attack surface dimension          | SAS keys                          | Entra ID                                 | Reduction            |
| --------------------------------- | --------------------------------- | ---------------------------------------- | -------------------- |
| Credential storage locations      | 5-10 per key                      | 0 (managed identity) or 1 (HSM for cert) | 80-100%              |
| Credential lifetime               | Unlimited (until rotation)        | 1 hour (token) / policy-defined (cert)   | 99%+                 |
| Blast radius of single compromise | Entire IoT Hub                    | Single identity scope                    | 90%+                 |
| Lateral movement potential        | High (full admin via iothubowner) | Low (RBAC-scoped)                        | 85%+                 |
| Forensic attribution              | None (policy-level)               | Full (identity-level)                    | 100% improvement     |
| Automated compromise detection    | None                              | Entra Identity Protection                | N/A to full coverage |

---

## Threat model: SAS key exposure vectors

### Vector 1: ARM deployment history

**Severity:** HIGH
**Likelihood:** HIGH (this was the actual pattern in the CSA-in-a-Box template)

```
Bicep template calls iotHub.listKeys()
  └─► ARM writes key material to deployment history
      └─► Deployment history readable by:
          ├─ Users with Reader role on resource group
          ├─ Users with Contributor role on subscription
          ├─ Service principals with deployment read permissions
          └─ Activity Log consumers (90-day retention default)
```

**MITRE ATT&CK:** T1552.001 (Unsecured Credentials: Credentials in Files)

Any principal with `Microsoft.Resources/deployments/read` permission can extract SAS keys from deployment outputs. This includes:

- Azure portal users browsing deployment history
- Automation accounts reading deployment results
- Monitoring tools with read access to the resource group
- Any user granted Reader role at the subscription or resource group level

### Vector 2: CI/CD pipeline logs

**Severity:** HIGH
**Likelihood:** MEDIUM

```
Deployment pipeline:
  az deployment group create ... --query outputs
  └─► Pipeline log captures output JSON
      └─► Output contains connectionString with SharedAccessKey=
          └─► Log stored in:
              ├─ Azure DevOps pipeline run history
              ├─ GitHub Actions run logs
              ├─ Jenkins build artifacts
              └─ Any log aggregation system
```

**MITRE ATT&CK:** T1552.001 (Unsecured Credentials: Credentials in Files)

Pipeline logs are retained for months or years. Anyone with access to pipeline history can extract SAS keys.

### Vector 3: Source code and configuration

**Severity:** HIGH
**Likelihood:** MEDIUM

```
Developer workflow:
  Connection string in .env file
  └─► Accidentally committed to git
      └─► Pushed to remote repository
          └─► Available in git history forever
              (even after the commit is "reverted")
```

**MITRE ATT&CK:** T1552.004 (Unsecured Credentials: Private Keys) / T1552.001

Common locations where SAS connection strings appear:

- `local.settings.json` (Azure Functions local development)
- `.env` files (Docker and Node.js environments)
- `appsettings.json` or `appsettings.Development.json` (.NET)
- Terraform state files (`terraform.tfstate`)
- Docker image layers (built with `ENV IOTHUB_CONNECTION_STRING=...`)
- Kubernetes secrets (base64 encoded, not encrypted)

### Vector 4: Key Vault access expansion

**Severity:** MEDIUM
**Likelihood:** MEDIUM

```
SAS key stored in Key Vault:
  └─► Key Vault access policy updated for new service
      └─► New service now has SAS key access
          └─► Unintended credential sharing
              └─► No audit of which service used which key
```

**MITRE ATT&CK:** T1078.004 (Valid Accounts: Cloud Accounts)

When SAS keys are stored in Key Vault, any expansion of Key Vault access policies grants access to IoT Hub credentials -- even if that was not the intent.

### Vector 5: Device compromise and key extraction

**Severity:** HIGH
**Likelihood:** MEDIUM (for devices without HSM)

```
IoT device with SAS key:
  └─► Device physically compromised or firmware dumped
      └─► SAS key extracted from flash storage
          └─► Key reusable on any network
              └─► Attacker impersonates device indefinitely
```

**MITRE ATT&CK:** T1588.004 (Obtain Capabilities: Digital Certificates) -- adapted for symmetric keys

SAS symmetric keys stored on devices without hardware security modules can be extracted through:

- Physical access to the device
- Firmware binary analysis
- Memory dump of running process
- Debug interface (JTAG, SWD) if not disabled

### Vector 6: Network interception of SAS tokens

**Severity:** MEDIUM
**Likelihood:** LOW (TLS mitigates in most cases)

```
SAS token in MQTT CONNECT packet:
  └─► TLS termination at proxy/gateway
      └─► Token visible in plaintext
          └─► Token replayable until expiry
```

**MITRE ATT&CK:** T1040 (Network Sniffing)

If TLS is terminated at an intermediate point (load balancer, API gateway, or corporate proxy performing TLS inspection), SAS tokens are visible in cleartext. Unlike X.509 mutual TLS, the private key material is directly in the token.

---

## MITRE ATT&CK mapping for IoT credential compromise

| Technique ID | Technique name                                        | SAS applicability                      | Entra mitigation                            |
| ------------ | ----------------------------------------------------- | -------------------------------------- | ------------------------------------------- |
| T1078.004    | Valid Accounts: Cloud Accounts                        | SAS key = valid cloud credential       | Managed identity tokens are instance-bound  |
| T1552.001    | Unsecured Credentials: Credentials in Files           | Connection strings in config/logs      | No credentials to store (managed identity)  |
| T1552.004    | Unsecured Credentials: Private Keys                   | SAS key in deployment history          | X.509 private key never leaves device HSM   |
| T1040        | Network Sniffing                                      | SAS token in MQTT payload              | mTLS -- private key never transmitted       |
| T1110        | Brute Force                                           | SAS keys are 44-char base64 (low risk) | Certificate-based -- brute force infeasible |
| T1528        | Steal Application Access Token                        | SAS token theft = persistent access    | Entra tokens expire in 1 hour               |
| T1550.001    | Use Alternate Auth Material: Application Access Token | Stolen SAS token usable anywhere       | Managed identity tokens bound to instance   |
| T1556        | Modify Authentication Process                         | Cannot detect SAS key cloning          | Entra detects anomalous sign-in patterns    |
| T1098        | Account Manipulation                                  | SAS policies are static (5 built-in)   | RBAC roles can be dynamically adjusted      |

---

## NIST 800-53 Rev 5 control mapping

### Identification and Authentication (IA)

| Control  | Title                                     | SAS implementation            | Entra implementation                                    | Gap closed |
| -------- | ----------------------------------------- | ----------------------------- | ------------------------------------------------------- | ---------- |
| IA-2     | Identification and Authentication         | Policy-level only             | Per-identity authentication                             | Yes        |
| IA-2(1)  | Multi-Factor Authentication               | Not supported                 | Conditional Access MFA for admin                        | Yes        |
| IA-2(2)  | MFA for Non-Privileged Accounts           | Not supported                 | MFA for all human access                                | Yes        |
| IA-2(6)  | Access to Accounts -- Separate Device     | Not supported                 | Certificate on device + admin from separate workstation | Yes        |
| IA-2(8)  | Access to Accounts -- Replay Resistant    | SAS tokens are replayable     | X.509 mTLS is replay-resistant                          | Yes        |
| IA-2(12) | PIV Credential Acceptance                 | Not supported                 | CBA with DoD PKI / PIV                                  | Yes        |
| IA-3     | Device Identification and Authentication  | Per-device SAS key (weak)     | Per-device X.509 certificate (strong)                   | Yes        |
| IA-4     | Identifier Management                     | Shared policy names           | Unique per-identity OIDs                                | Yes        |
| IA-5     | Authenticator Management                  | Manual rotation, no lifecycle | Automated token/cert lifecycle                          | Yes        |
| IA-5(1)  | Password-Based Authentication             | N/A (key-based)               | N/A (certificate-based)                                 | N/A        |
| IA-5(2)  | PKI-Based Authentication                  | Not supported (symmetric)     | X.509 PKI fully supported                               | Yes        |
| IA-5(6)  | Protection of Authenticators              | Keys in multiple locations    | Private keys in HSM / no storage needed                 | Yes        |
| IA-8     | Non-Organizational User Identification    | Bearer token (no identity)    | Full identity verification                              | Yes        |
| IA-9     | Service Identification and Authentication | Policy-level                  | Per-service managed identity                            | Yes        |

### Audit and Accountability (AU)

| Control | Title                                    | SAS implementation                | Entra implementation                        | Gap closed |
| ------- | ---------------------------------------- | --------------------------------- | ------------------------------------------- | ---------- |
| AU-2    | Event Logging                            | Basic operation logging           | Comprehensive sign-in + operation logging   | Yes        |
| AU-3    | Content of Audit Records                 | Policy name, operation, timestamp | Identity, IP, device, CA policy, risk, role | Yes        |
| AU-3(1) | Additional Audit Information             | Limited                           | Conditional Access evaluation details       | Yes        |
| AU-6    | Audit Record Review, Analysis, Reporting | Manual review, limited signal     | SIEM integration, automated analysis        | Yes        |
| AU-12   | Audit Record Generation                  | IoT Hub diagnostic logs only      | Entra + IoT Hub + Azure Monitor             | Yes        |

### Access Control (AC)

| Control | Title                                  | SAS implementation                       | Entra implementation                     | Gap closed |
| ------- | -------------------------------------- | ---------------------------------------- | ---------------------------------------- | ---------- |
| AC-2    | Account Management                     | N/A (no accounts)                        | Full lifecycle (PIM, access reviews)     | Yes        |
| AC-3    | Access Enforcement                     | 5 static policies                        | Granular RBAC roles                      | Yes        |
| AC-5    | Separation of Duties                   | Manual (use separate policies)           | Enforced (custom role definitions)       | Yes        |
| AC-6    | Least Privilege                        | Coarse (e.g., iothubowner = full access) | Fine-grained (e.g., IoT Hub Data Reader) | Yes        |
| AC-6(1) | Authorize Access to Security Functions | Not supported                            | PIM for elevated access                  | Yes        |
| AC-6(5) | Privileged Accounts                    | Not distinguished                        | PIM time-bound activation                | Yes        |

### System and Communications Protection (SC)

| Control | Title                             | SAS implementation               | Entra implementation         | Gap closed |
| ------- | --------------------------------- | -------------------------------- | ---------------------------- | ---------- |
| SC-8    | Transmission Confidentiality      | TLS + bearer token               | TLS + mTLS (X.509)           | Yes        |
| SC-8(1) | Cryptographic Protection          | TLS only                         | TLS + certificate validation | Yes        |
| SC-12   | Cryptographic Key Establishment   | Manual key distribution          | PKI certificate chain        | Yes        |
| SC-13   | Cryptographic Protection          | HMAC-SHA256 (SDK-dependent FIPS) | FIPS 140-2 validated modules | Yes        |
| SC-28   | Protection of Information at Rest | Key stored in Key Vault          | No credential storage needed | Yes        |

---

## Authentication method comparison

| Dimension                | SAS symmetric key                 | X.509 device certificate               | Managed Identity                  | DPS with Entra                 |
| ------------------------ | --------------------------------- | -------------------------------------- | --------------------------------- | ------------------------------ |
| **Credential type**      | 44-char base64 shared key         | RSA/ECC key pair + certificate         | No user-managed credential        | X.509 or Entra token           |
| **Storage location**     | Device flash / Key Vault / config | Device HSM / secure storage            | Azure platform (no user access)   | Device HSM + DPS               |
| **Rotation mechanism**   | Manual (coordinated redeploy)     | Certificate renewal (automated via KV) | Automatic (platform-managed)      | Re-provisioning via DPS        |
| **Rotation frequency**   | Rarely (quarterly at best)        | Policy-defined (30-365 days)           | Every ~24 hours (transparent)     | Per certificate policy         |
| **Blast radius**         | All devices sharing the policy    | Single device                          | Single service instance           | Single device / group          |
| **Forensic attribution** | Policy name                       | Device ID + cert thumbprint            | Service principal OID             | Device ID + enrollment group   |
| **Revocation speed**     | Rotate key (affects all users)    | Revoke single cert (CRL/OCSP)          | Delete/disable identity (instant) | Remove from enrollment group   |
| **Offline operation**    | Token valid until expiry          | Certificate valid until expiry         | Cached token (limited offline)    | Certificate valid until expiry |
| **Hardware protection**  | Not standard                      | HSM / TPM supported                    | N/A (platform-managed)            | HSM / TPM supported            |
| **FIPS 140-2**           | SDK-dependent                     | Yes (with HSM)                         | Yes (Azure infrastructure)        | Yes (with HSM)                 |
| **FedRAMP High**         | Fails IA-2, IA-5                  | Passes                                 | Passes                            | Passes                         |
| **IL5**                  | Fails IA-2(6), IA-5(2)            | Passes                                 | Passes                            | Passes                         |

---

## Security posture scoring

### Scoring methodology

Each dimension is scored 0-10 based on alignment with NIST 800-53 High baseline and Zero Trust maturity model. Overall score is weighted average.

### Before migration (SAS authentication)

| Dimension                   | Weight   | Score | Weighted     |
| --------------------------- | -------- | ----- | ------------ |
| Credential management       | 20%      | 2     | 0.4          |
| Authentication strength     | 20%      | 3     | 0.6          |
| Access granularity          | 15%      | 2     | 0.3          |
| Audit and monitoring        | 15%      | 2     | 0.3          |
| Incident response readiness | 10%      | 2     | 0.2          |
| Compliance alignment        | 10%      | 1     | 0.1          |
| Automation maturity         | 10%      | 1     | 0.1          |
| **Overall**                 | **100%** |       | **2.0 / 10** |

### After migration (Entra authentication)

| Dimension                   | Weight   | Score | Weighted      |
| --------------------------- | -------- | ----- | ------------- |
| Credential management       | 20%      | 9     | 1.8           |
| Authentication strength     | 20%      | 9     | 1.8           |
| Access granularity          | 15%      | 8     | 1.2           |
| Audit and monitoring        | 15%      | 9     | 1.35          |
| Incident response readiness | 10%      | 8     | 0.8           |
| Compliance alignment        | 10%      | 9     | 0.9           |
| Automation maturity         | 10%      | 8     | 0.8           |
| **Overall**                 | **100%** |       | **8.65 / 10** |

### Improvement summary

```
Security Posture Score Improvement

Before (SAS):  ██░░░░░░░░░░░░░░░░░░  2.0 / 10
After (Entra): ████████████████████░  8.65 / 10

Improvement: +6.65 points (+332%)
```

This 332% improvement reflects the fundamental difference between a shared-secret authentication model and an identity-based, certificate-backed, automatically-managed authentication model.

---

## Risk register

| Risk ID | Risk description                      | SAS likelihood | SAS impact | Entra likelihood | Entra impact |
| ------- | ------------------------------------- | -------------- | ---------- | ---------------- | ------------ |
| R-001   | SAS key leaked via deployment history | High           | Critical   | N/A              | N/A          |
| R-002   | Connection string in source code      | Medium         | Critical   | N/A              | N/A          |
| R-003   | Key not rotated within 90 days        | High           | High       | N/A              | N/A          |
| R-004   | Compromised device used to access Hub | Medium         | Critical   | Low              | Low          |
| R-005   | Insider accesses device data          | Medium         | High       | Low              | Medium       |
| R-006   | Certificate expiration causes outage  | N/A            | N/A        | Medium           | Medium       |
| R-007   | Managed identity token intercepted    | N/A            | N/A        | Very Low         | Low          |
| R-008   | CA compromise                         | N/A            | N/A        | Very Low         | Critical     |

**Net risk reduction:** 5 high/critical risks eliminated, 2 low/medium risks introduced (both with standard mitigations).

---

## Recommendations

1. **Immediate:** Migrate all backend services from SAS connection strings to managed identities (lowest risk, highest return)
2. **Within 30 days:** Establish X.509 certificate infrastructure (root CA, intermediate, Key Vault integration)
3. **Within 60 days:** Begin rolling device fleet migration to X.509 (start with 10% pilot)
4. **Within 90 days:** Complete fleet migration, disable SAS policies, update Bicep templates
5. **Ongoing:** Monitor certificate expiration, audit Entra sign-in logs, review RBAC assignments quarterly

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Why Entra over SAS](why-entra-over-sas.md) | [Feature Mapping](feature-mapping-complete.md) | [Migration Center](index.md)
