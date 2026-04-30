# Total Cost of Ownership: On-Premises AD vs Microsoft Entra ID

**Detailed cost analysis for CFOs, CIOs, and procurement teams evaluating the financial case for migrating from on-premises Active Directory infrastructure to Microsoft Entra ID.**

---

## Executive summary

On-premises Active Directory infrastructure carries costs that extend far beyond server hardware. Domain controllers, AD FS farms, AD CS PKI, MFA servers, RADIUS/NPS infrastructure, and the FTE burden of managing these systems create a total cost of ownership that most organizations underestimate by 40--60%.

This analysis presents a transparent, itemized cost comparison across three federal tenant sizes: small (500 users), medium (5,000 users), and large (25,000 users). The conclusion is consistent across all sizes: **Entra ID reduces identity infrastructure TCO by 50--65%** while simultaneously improving security posture, compliance readiness, and operational agility.

---

## 1. On-premises AD cost model

### 1.1 Domain controller infrastructure

Domain controllers are the backbone of Active Directory. Minimum deployment is two DCs per site for fault tolerance; large enterprises run 4--8 per datacenter plus branch office DCs.

| Cost item                          | Small (500 users) | Medium (5,000 users) | Large (25,000 users) | Notes                                      |
| ---------------------------------- | ----------------- | -------------------- | -------------------- | ------------------------------------------ |
| Physical servers (2--8 DCs)        | $15,000           | $60,000              | $200,000             | Refresh every 4--5 years                   |
| Windows Server Datacenter licenses | $12,000           | $48,000              | $160,000             | Per-core licensing; 2 cores per DC minimum |
| Windows Server CALs (user)         | $2,500            | $25,000              | $125,000             | ~$5/user/year                              |
| Rack space / hosting               | $6,000            | $24,000              | $72,000              | $500--$750/U/month colo                    |
| Power and cooling                  | $3,600            | $14,400              | $48,000              | ~$0.12/kWh estimate                        |
| Hardware maintenance contracts     | $3,000            | $12,000              | $40,000              | 15--20% of hardware cost                   |
| **DC subtotal (annual)**           | **$42,100**       | **$183,400**         | **$645,000**         |                                            |

### 1.2 AD FS infrastructure

AD FS farms provide federated SSO for cloud applications. Minimum deployment: 2 AD FS servers + 2 Web Application Proxy (WAP) servers.

| Cost item                            | Small       | Medium      | Large        | Notes                                 |
| ------------------------------------ | ----------- | ----------- | ------------ | ------------------------------------- |
| AD FS servers (2--4)                 | $8,000      | $20,000     | $40,000      | Hardware + Windows Server license     |
| WAP servers (2--4)                   | $8,000      | $20,000     | $40,000      | DMZ placement                         |
| SSL certificates (public)            | $1,500      | $3,000      | $6,000       | Wildcard or SAN certificates          |
| Load balancer (hardware/virtual)     | $5,000      | $10,000     | $20,000      | F5, NetScaler, or Azure Load Balancer |
| Token signing certificate management | $2,000      | $4,000      | $8,000       | Annual renewal and rollover           |
| **AD FS subtotal (annual)**          | **$24,500** | **$57,000** | **$114,000** |                                       |

### 1.3 AD CS (PKI) infrastructure

Active Directory Certificate Services provides internal PKI for smart card logon, SSL certificates, code signing, and EFS.

| Cost item                        | Small       | Medium      | Large       | Notes                                 |
| -------------------------------- | ----------- | ----------- | ----------- | ------------------------------------- |
| Root CA (offline, air-gapped)    | $3,000      | $5,000      | $10,000     | Hardware + HSM for key protection     |
| Issuing CA servers (1--2)        | $5,000      | $12,000     | $24,000     | Online, domain-joined                 |
| HSM (hardware security module)   | $8,000      | $15,000     | $30,000     | FIPS 140-2 Level 3 for federal        |
| CRL/OCSP responder               | $2,000      | $4,000      | $8,000      | High-availability required            |
| Certificate lifecycle management | $3,000      | $8,000      | $20,000     | Third-party tools (Venafi, Keyfactor) |
| **AD CS subtotal (annual)**      | **$21,000** | **$44,000** | **$92,000** |                                       |

### 1.4 MFA and RADIUS infrastructure

| Cost item                                    | Small       | Medium      | Large        | Notes                               |
| -------------------------------------------- | ----------- | ----------- | ------------ | ----------------------------------- |
| MFA server (Azure MFA Server or third-party) | $5,000      | $15,000     | $40,000      | Duo, RSA, or Azure MFA Server (EOL) |
| RADIUS/NPS servers (2+)                      | $4,000      | $10,000     | $20,000      | Network device authentication       |
| Hardware tokens (if used)                    | $5,000      | $25,000     | $100,000     | RSA SecurID, YubiKey fleet          |
| **MFA/RADIUS subtotal (annual)**             | **$14,000** | **$50,000** | **$160,000** |                                     |

### 1.5 Personnel costs

Identity administration is labor-intensive for on-premises AD. These are fully loaded FTE costs at federal GS-13/GS-14 equivalent rates.

| Role                        | Small (FTE)  | Medium (FTE) | Large (FTE)    | Cost per FTE | Notes                                  |
| --------------------------- | ------------ | ------------ | -------------- | ------------ | -------------------------------------- |
| AD administrator            | 0.5          | 1.5          | 3.0            | $140,000     | DC management, replication, schema     |
| PKI administrator           | 0.25         | 0.5          | 1.0            | $150,000     | Certificate lifecycle, CA management   |
| AD FS administrator         | 0.25         | 0.5          | 1.0            | $145,000     | Federation, certificate rollover       |
| Group Policy administrator  | 0.5          | 1.0          | 2.0            | $135,000     | GPO creation, testing, troubleshooting |
| Help desk (password resets) | 0.5          | 2.0          | 5.0            | $75,000      | $70/incident average                   |
| Security monitoring         | 0.25         | 0.5          | 1.0            | $155,000     | AD audit log review, threat detection  |
| **Personnel subtotal**      | **$240,000** | **$785,000** | **$1,845,000** |              |                                        |

### 1.6 On-premises AD total cost of ownership

| Category                 | Small (500 users) | Medium (5,000 users) | Large (25,000 users) |
| ------------------------ | ----------------- | -------------------- | -------------------- |
| Domain controllers       | $42,100           | $183,400             | $645,000             |
| AD FS                    | $24,500           | $57,000              | $114,000             |
| AD CS (PKI)              | $21,000           | $44,000              | $92,000              |
| MFA / RADIUS             | $14,000           | $50,000              | $160,000             |
| Personnel                | $240,000          | $785,000             | $1,845,000           |
| **Annual TCO**           | **$341,600**      | **$1,119,400**       | **$2,856,000**       |
| **Per-user annual cost** | **$683**          | **$224**             | **$114**             |

---

## 2. Entra ID cost model

### 2.1 Licensing

Entra ID licensing is typically included in Microsoft 365 E3/E5 subscriptions that federal agencies already hold. The incremental cost for identity is embedded in the M365 license.

| License tier                           | Monthly/user | Annual/user | Key identity features                                                      |
| -------------------------------------- | ------------ | ----------- | -------------------------------------------------------------------------- |
| Entra ID Free                          | $0           | $0          | Basic directory, SSO (10 apps), MFA defaults                               |
| Entra ID P1 (included in M365 E3)      | Included     | Included    | Conditional Access, dynamic groups, App Proxy, self-service password reset |
| Entra ID P2 (included in M365 E5)      | Included     | Included    | Identity Protection, PIM, access reviews, entitlement management           |
| Entra ID P2 standalone                 | $9           | $108        | When M365 E5 is not licensed                                               |
| Intune Plan 1 (included in M365 E3/E5) | Included     | Included    | Device management, compliance policies, configuration profiles             |

!!! note "Federal licensing"
Most federal agencies license M365 E3 or E5 (GCC/GCC High). Entra ID P1/P2 and Intune Plan 1 are included at no incremental cost. The TCO analysis below assumes M365 E5 is already licensed --- the Entra ID cost is $0 incremental.

### 2.2 Infrastructure costs

| Cost item                                | Small      | Medium     | Large      | Notes                                                 |
| ---------------------------------------- | ---------- | ---------- | ---------- | ----------------------------------------------------- |
| Cloud Sync agents (2--3 lightweight VMs) | $2,400     | $4,800     | $9,600     | During hybrid phase only; eliminated post-migration   |
| Azure AD Domain Services (if needed)     | $3,600     | $7,200     | $14,400    | Only for legacy LDAP apps; most migrations avoid this |
| Azure Private Link for Entra             | Included   | Included   | Included   | No incremental cost                                   |
| **Infrastructure subtotal (annual)**     | **$2,400** | **$4,800** | **$9,600** | Hybrid phase only                                     |

### 2.3 Personnel costs (post-migration)

| Role                                 | Small (FTE) | Medium (FTE) | Large (FTE)  | Cost per FTE | Notes                                         |
| ------------------------------------ | ----------- | ------------ | ------------ | ------------ | --------------------------------------------- |
| Entra ID administrator               | 0.25        | 0.5          | 1.5          | $150,000     | Conditional Access, SSO, identity lifecycle   |
| Intune administrator                 | 0.25        | 0.5          | 1.0          | $145,000     | Device policies, compliance, configuration    |
| Identity security analyst            | 0.1         | 0.25         | 0.5          | $160,000     | Identity Protection review (mostly automated) |
| Help desk (reduced --- passwordless) | 0.1         | 0.5          | 1.5          | $75,000      | 70% reduction from passwordless + SSPR        |
| **Personnel subtotal**               | **$85,000** | **$230,000** | **$580,000** |              |                                               |

### 2.4 One-time migration costs

| Cost item                              | Small       | Medium       | Large        | Notes                                          |
| -------------------------------------- | ----------- | ------------ | ------------ | ---------------------------------------------- |
| Migration planning and assessment      | $20,000     | $60,000      | $150,000     | Discovery, application inventory, GPO analysis |
| Application remediation                | $15,000     | $80,000      | $250,000     | LDAP/Kerberos app modernization                |
| Device migration (Intune enrollment)   | $10,000     | $50,000      | $150,000     | Autopilot, Hybrid Join, Entra Join             |
| Staff training                         | $5,000      | $15,000      | $40,000      | Entra ID, Intune, Conditional Access           |
| Parallel running (dual infrastructure) | $30,000     | $100,000     | $300,000     | 6--12 months of coexistence                    |
| **Migration subtotal (one-time)**      | **$80,000** | **$305,000** | **$890,000** |                                                |

### 2.5 Entra ID total cost of ownership

| Category                         | Small (500 users) | Medium (5,000 users) | Large (25,000 users) |
| -------------------------------- | ----------------- | -------------------- | -------------------- |
| Entra ID licensing (incremental) | $0                | $0                   | $0                   |
| Infrastructure (hybrid phase)    | $2,400            | $4,800               | $9,600               |
| Personnel                        | $85,000           | $230,000             | $580,000             |
| **Annual TCO (steady state)**    | **$87,400**       | **$234,800**         | **$589,600**         |
| **Per-user annual cost**         | **$175**          | **$47**              | **$24**              |

---

## 3. TCO comparison --- 3-year projection

### Year-by-year analysis (medium tenant --- 5,000 users)

| Year               | On-premises AD | Entra ID       | Savings        | Notes                                     |
| ------------------ | -------------- | -------------- | -------------- | ----------------------------------------- |
| Year 1             | $1,119,400     | $539,800       | $579,600       | Includes $305K one-time migration cost    |
| Year 2             | $1,119,400     | $234,800       | $884,600       | Steady state; hybrid infra decommissioned |
| Year 3             | $1,175,000     | $234,800       | $940,200       | AD hardware refresh due (+5%)             |
| **3-year total**   | **$3,413,800** | **$1,009,400** | **$2,404,400** |                                           |
| **3-year savings** |                |                | **70%**        |                                           |

### 3-year TCO summary (all tenant sizes)

| Metric                 | Small (500)  | Medium (5,000) | Large (25,000) |
| ---------------------- | ------------ | -------------- | -------------- |
| AD 3-year TCO          | $1,024,800   | $3,413,800     | $8,668,000     |
| Entra ID 3-year TCO    | $342,200     | $1,009,400     | $2,658,800     |
| **3-year savings**     | **$682,600** | **$2,404,400** | **$6,009,200** |
| **Savings percentage** | **67%**      | **70%**        | **69%**        |

---

## 4. TCO comparison --- 5-year projection

### 5-year TCO summary (all tenant sizes)

| Metric                 | Small (500)    | Medium (5,000) | Large (25,000)  |
| ---------------------- | -------------- | -------------- | --------------- |
| AD 5-year TCO          | $1,793,000     | $5,752,000     | $14,580,000     |
| Entra ID 5-year TCO    | $517,000       | $1,479,000     | $3,838,000      |
| **5-year savings**     | **$1,276,000** | **$4,273,000** | **$10,742,000** |
| **Savings percentage** | **71%**        | **74%**        | **74%**         |

!!! info "Compounding savings"
The savings percentage increases over 5 years because on-premises AD costs include hardware refresh cycles (every 4--5 years), software license inflation (~5% annually), and growing personnel costs. Entra ID costs remain flat or decrease as automation matures and passwordless reduces help desk volume.

---

## 5. Hidden costs of on-premises AD

These costs are frequently omitted from TCO analyses but are material:

### 5.1 Security breach risk

| Risk scenario                          | Probability (annual) | Average cost | Risk-adjusted cost |
| -------------------------------------- | -------------------- | ------------ | ------------------ |
| Credential compromise (password spray) | 15--25%              | $250K--$1M   | $37K--$250K        |
| Ransomware (AD as pivot point)         | 5--10%               | $1M--$5M     | $50K--$500K        |
| AD CS abuse (privilege escalation)     | 3--8%                | $500K--$2M   | $15K--$160K        |
| Golden ticket / DCSync attack          | 1--3%                | $2M--$10M    | $20K--$300K        |
| **Annual risk-adjusted cost**          |                      |              | **$122K--$1.2M**   |

Entra ID reduces these risks by eliminating the attack vectors entirely (no Kerberos, no NTLM, no AD CS, no DC replication protocol exposure).

### 5.2 Compliance audit costs

| Activity                          | AD (annual) | Entra ID (annual) | Delta |
| --------------------------------- | ----------- | ----------------- | ----- |
| FedRAMP identity control evidence | $40K--$80K  | $10K--$20K        | -75%  |
| SOC 2 identity controls           | $30K--$60K  | $5K--$15K         | -75%  |
| Internal audit (identity)         | $20K--$40K  | $5K--$10K         | -75%  |
| Penetration testing (AD-focused)  | $25K--$50K  | $10K--$20K        | -60%  |

### 5.3 Productivity loss

| Scenario                                                          | AD impact                                | Entra ID impact                | Delta |
| ----------------------------------------------------------------- | ---------------------------------------- | ------------------------------ | ----- |
| Password reset (15 min/incident, 500 incidents/year for 5K users) | 125 hours lost                           | 25 hours (SSPR + passwordless) | -80%  |
| VPN requirement for AD auth (remote workers)                      | 30 sec/connection, 50K connections/month | No VPN required                | -100% |
| Application SSO setup (per app, per year)                         | 8 hours/app                              | 0.5 hours/app (gallery)        | -94%  |

---

## 6. Sensitivity analysis

### Key variables affecting TCO

| Variable                      | Low scenario         | Base scenario     | High scenario        | Impact on savings |
| ----------------------------- | -------------------- | ----------------- | -------------------- | ----------------- |
| M365 E5 already licensed      | Yes ($0 incremental) | Yes               | No (+$108/user/year) | -15% to +0%       |
| Application remediation scope | 5 apps               | 20 apps           | 50+ apps             | -$50K to +$200K   |
| Device fleet size             | Low (BYOD-heavy)     | Medium            | High (all managed)   | -$30K to +$100K   |
| GPO complexity                | Simple (50 GPOs)     | Medium (200 GPOs) | Complex (500+ GPOs)  | -$20K to +$80K    |
| Hardware refresh timing       | Recently refreshed   | Mid-lifecycle     | Due for refresh      | -$50K to +$100K   |
| Hybrid phase duration         | 6 months             | 12 months         | 24 months            | -$20K to +$60K    |

### Break-even analysis

| Tenant size    | Migration cost | Annual savings | Break-even     |
| -------------- | -------------- | -------------- | -------------- |
| Small (500)    | $80,000        | $254,200       | **3.8 months** |
| Medium (5,000) | $305,000       | $884,600       | **4.1 months** |
| Large (25,000) | $890,000       | $2,266,400     | **4.7 months** |

All scenarios break even within the first year --- typically within the first two quarters.

---

## 7. CSA-in-a-Box cost integration

Entra ID identity costs are embedded in the broader CSA-in-a-Box platform TCO. Identity is not a separate line item --- it is the security foundation.

| CSA-in-a-Box service               | Identity cost component       | Notes                     |
| ---------------------------------- | ----------------------------- | ------------------------- |
| Fabric workspace access            | $0 (Entra group-based RBAC)   | No per-user identity cost |
| Databricks SCIM provisioning       | $0 (included in Entra ID)     | Automatic sync            |
| Purview governance policies        | $0 (Entra group-based access) | Data steward via Entra    |
| Key Vault managed identity         | $0 (managed identity is free) | No service account cost   |
| Azure Monitor RBAC                 | $0 (Entra RBAC included)      | Log Analytics access      |
| Conditional Access (platform-wide) | $0 (included in P1/P2)        | Enforced on all services  |

---

## 8. Procurement guidance for federal agencies

### GSA schedule alignment

- **M365 E5 GCC/GCC High:** Available on GSA MAS (Multiple Award Schedule), IT Category
- **Azure Government consumption:** Available on GSA cloud SIN (Special Item Number)
- **Entra ID standalone P2:** Available as standalone SKU if M365 E5 is not licensed

### Cost avoidance justification

For OMB budget submissions, frame the migration as cost avoidance:

```
Justification: Migration from on-premises Active Directory to Microsoft Entra ID
Cost avoidance (5-year): $4.3M (medium tenant, 5,000 users)
Security posture improvement: Eliminates 7 critical AD attack vectors
Compliance: Satisfies EO 14028 identity pillar requirements
Prerequisite: Required for CSA-in-a-Box data platform deployment
ROI: Break-even at 4.1 months post-migration
```

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
