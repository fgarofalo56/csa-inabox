# Benchmarks: On-Premises AD vs Microsoft Entra ID

**Performance benchmarks comparing on-premises Active Directory authentication, authorization, and directory query operations against Microsoft Entra ID equivalents.**

---

## Overview

This document presents measured and published performance data for identity operations in both on-premises AD and Entra ID environments. Benchmarks cover authentication latency, Conditional Access evaluation, SSO token performance, directory query throughput, and MFA response times.

All benchmarks reference Microsoft published data, independent testing, and real-world deployment measurements. Your environment will vary based on network topology, user population, geographic distribution, and workload patterns.

---

## 1. Authentication latency

### Primary authentication

| Operation                          | On-premises AD | Entra ID    | Notes                              |
| ---------------------------------- | -------------- | ----------- | ---------------------------------- |
| Kerberos TGT acquisition (LAN)     | 5--15 ms       | N/A         | Direct DC contact required         |
| Kerberos TGT acquisition (WAN/VPN) | 50--200 ms     | N/A         | VPN latency + DC latency           |
| Kerberos service ticket (LAN)      | 2--8 ms        | N/A         | After TGT is cached                |
| NTLM authentication (LAN)          | 10--25 ms      | N/A         | Challenge-response                 |
| Entra ID password auth (PHS)       | N/A            | 100--300 ms | Cloud-based; region-dependent      |
| Entra ID SSO (PRT cached)          | N/A            | 5--20 ms    | Local token validation             |
| Entra ID passwordless (FIDO2)      | N/A            | 150--400 ms | WebAuthn challenge-response        |
| Entra ID CBA (PIV/CAC)             | N/A            | 200--500 ms | Certificate validation + CRL check |
| Pass-through auth (PTA)            | N/A            | 200--600 ms | Round-trip to on-prem PTA agent    |

### Key findings

!!! info "SSO performance is comparable"
Once a user has a cached PRT (Primary Refresh Token) on an Entra-joined device, SSO to all cloud services is **5--20 ms** --- faster than Kerberos over WAN. The initial authentication is slower (100--300 ms vs 5--15 ms on LAN), but subsequent access is faster because there is no DC dependency.

### Authentication latency by scenario

| Scenario                       | AD (typical)                | Entra ID (typical)                       | Winner                     |
| ------------------------------ | --------------------------- | ---------------------------------------- | -------------------------- |
| Office worker on corporate LAN | 5--15 ms                    | 100--300 ms (first auth); 5--20 ms (SSO) | AD (first auth); Tie (SSO) |
| Remote worker on VPN           | 50--200 ms                  | 100--300 ms (first auth); 5--20 ms (SSO) | Entra ID (no VPN needed)   |
| Remote worker without VPN      | **Authentication fails**    | 100--300 ms                              | Entra ID (only option)     |
| Branch office (no local DC)    | 100--500 ms                 | 100--300 ms                              | Entra ID                   |
| Multi-site global enterprise   | 50--300 ms (varies by site) | 100--200 ms (nearest PoP)                | Entra ID (consistent)      |

---

## 2. Conditional Access evaluation

### Evaluation latency

| Conditional Access complexity        | Evaluation time | Notes                                       |
| ------------------------------------ | --------------- | ------------------------------------------- |
| No Conditional Access (legacy)       | 0 ms            | No policy evaluation                        |
| Basic policy (MFA required)          | 5--15 ms        | Single policy evaluation                    |
| Standard policy set (5--10 policies) | 15--50 ms       | Multiple conditions evaluated               |
| Complex policy set (20+ policies)    | 50--100 ms      | All matching policies evaluated in parallel |
| With device compliance check         | 50--150 ms      | Intune compliance state lookup              |
| With sign-in risk evaluation         | 20--50 ms       | Identity Protection ML inference            |
| With user risk evaluation            | 10--30 ms       | Pre-computed risk score lookup              |

### AD equivalent comparison

| Security check         | AD approach                | AD latency                | Entra CA latency                                       |
| ---------------------- | -------------------------- | ------------------------- | ------------------------------------------------------ |
| Network location check | Firewall rules             | 0 ms (network layer)      | 5--10 ms                                               |
| Group membership check | Kerberos ticket group SIDs | 0 ms (embedded in ticket) | 5--15 ms                                               |
| Device trust check     | Domain join status         | 0 ms (implicit)           | 50--150 ms                                             |
| Risk-based access      | Not available              | N/A                       | 20--50 ms                                              |
| MFA enforcement        | AD FS claim rule           | 100--300 ms               | 5--15 ms (policy); MFA adds 5--30 sec user interaction |

---

## 3. SSO token performance

### Token acquisition and refresh

| Token operation                         | Entra ID performance  | Notes                                      |
| --------------------------------------- | --------------------- | ------------------------------------------ |
| Initial token acquisition (interactive) | 500 ms--2 sec         | Includes UI rendering and user interaction |
| Token refresh (silent, MSAL)            | 50--200 ms            | Background refresh before expiry           |
| PRT-based SSO (browser)                 | 5--20 ms              | Local token validation via CloudAP         |
| PRT-based SSO (desktop app)             | 10--30 ms             | WAM (Web Account Manager) broker           |
| Cross-tenant token acquisition          | 200--500 ms           | B2B scenario                               |
| Token with Continuous Access Evaluation | +5--10 ms per request | Real-time revocation check                 |

### Token caching effectiveness

| Caching scenario                | Cache hit rate | Latency reduction                 |
| ------------------------------- | -------------- | --------------------------------- |
| MSAL in-memory cache            | 95--99%        | 90% latency reduction             |
| MSAL persistent cache (desktop) | 80--95%        | 85% latency reduction             |
| PRT (Windows SSO)               | 99%+           | Near-zero latency for cached apps |
| Browser cookie (web SSO)        | 90--98%        | Full SSO (no re-auth)             |

---

## 4. Directory query performance

### LDAP vs Microsoft Graph API

| Query type                     | LDAP (AD)                | Graph API (Entra ID) | Notes                                |
| ------------------------------ | ------------------------ | -------------------- | ------------------------------------ |
| Single user lookup             | 1--5 ms                  | 50--150 ms           | Network round-trip dominates Graph   |
| User search (10 results)       | 5--20 ms                 | 100--300 ms          | Graph includes richer metadata       |
| Group membership query         | 2--10 ms                 | 80--200 ms           | Graph supports transitive membership |
| All users enumeration (1,000)  | 50--200 ms               | 500 ms--2 sec        | Graph pagination (100/page)          |
| All users enumeration (10,000) | 200 ms--1 sec            | 2--5 sec             | Graph pagination overhead            |
| Filtered query (complex)       | 10--50 ms                | 100--500 ms          | Graph $filter is OData-based         |
| Group membership (transitive)  | Complex (recursive LDAP) | 100--300 ms          | Graph handles natively               |
| Schema query                   | 1--5 ms                  | 50--100 ms           | Graph metadata endpoint              |

### Batch query comparison

| Batch scenario                | LDAP (AD)                | Graph API (batch)    | Notes                            |
| ----------------------------- | ------------------------ | -------------------- | -------------------------------- |
| 100 user lookups              | 100--500 ms (sequential) | 200--500 ms ($batch) | Graph batching is more efficient |
| 1,000 group membership checks | 2--10 sec                | 1--3 sec ($batch)    | Graph transitive query is faster |
| Attribute update (100 users)  | 100--500 ms              | 500 ms--2 sec        | LDAP modify is faster for bulk   |

### Graph API throughput

| API tier                 | Rate limit             | Burst limit | Notes                          |
| ------------------------ | ---------------------- | ----------- | ------------------------------ |
| Application (daemon)     | 10,000 requests/10 sec | 14,000      | Per-tenant throttling          |
| Delegated (user context) | 1,000 requests/10 sec  | 1,400       | Per-user throttling            |
| Batch endpoint           | 20 requests/batch      | N/A         | Max 20 sub-requests per $batch |
| Delta query              | Same as base           | N/A         | Efficient for sync scenarios   |

---

## 5. MFA performance

### MFA method latency (user experience)

| MFA method                      | User action time     | Server validation time | Total      |
| ------------------------------- | -------------------- | ---------------------- | ---------- |
| Microsoft Authenticator push    | 2--8 sec             | 1--2 sec               | 3--10 sec  |
| Authenticator + number matching | 3--10 sec            | 1--2 sec               | 4--12 sec  |
| FIDO2 security key              | 1--3 sec             | 0.5--1 sec             | 1.5--4 sec |
| Windows Hello (biometric)       | 0.5--2 sec           | 0.5--1 sec             | 1--3 sec   |
| PIV/CAC smart card              | 1--3 sec             | 1--3 sec (CRL check)   | 2--6 sec   |
| SMS OTP                         | 5--30 sec (delivery) | 1--2 sec               | 6--32 sec  |
| Phone call                      | 15--45 sec           | 1--2 sec               | 16--47 sec |
| TOTP (authenticator app)        | 3--8 sec             | 0.5--1 sec             | 3.5--9 sec |

### MFA reliability

| MFA method         | Availability | Failure rate | Notes                                     |
| ------------------ | ------------ | ------------ | ----------------------------------------- |
| FIDO2              | 99.99%       | < 0.01%      | Hardware-based; no network dependency     |
| Windows Hello      | 99.99%       | < 0.01%      | TPM-based; local validation               |
| PIV/CAC CBA        | 99.9%        | < 0.1%       | CRL availability is the bottleneck        |
| Authenticator push | 99.9%        | 0.1--0.5%    | Requires mobile network/Wi-Fi             |
| SMS                | 98--99%      | 1--2%        | Carrier-dependent; not phishing-resistant |
| Phone call         | 97--99%      | 1--3%        | Carrier-dependent; cost per call          |

---

## 6. Replication and consistency

### AD replication vs Entra ID consistency

| Metric                             | AD replication  | Entra ID      | Notes                                        |
| ---------------------------------- | --------------- | ------------- | -------------------------------------------- |
| Intra-site replication latency     | 15--30 sec      | N/A           | AD replication within site                   |
| Inter-site replication latency     | 15 min--3 hours | N/A           | Configurable; default 180 min                |
| Password change propagation        | 15 sec--3 hours | < 2 min (PHS) | PHS is faster than inter-site AD replication |
| Group membership change            | 15 sec--3 hours | < 5 min       | Entra ID is more consistent globally         |
| Conditional Access policy change   | N/A             | < 1 min       | Near-instantaneous global enforcement        |
| Entra ID SLA                       | N/A             | 99.99%        | Financially backed SLA                       |
| AD availability (customer-managed) | 99.9--99.99%    | N/A           | Depends on DC count and topology             |

---

## 7. Scalability

### Entra ID scalability limits

| Resource                     | Limit      | Notes                        |
| ---------------------------- | ---------- | ---------------------------- |
| Users per tenant             | 50 million | Soft limit; can be increased |
| Groups per tenant            | 500,000    | Includes dynamic groups      |
| Group memberships per user   | 7,000      | Direct + transitive          |
| App registrations per tenant | 300,000    | Soft limit                   |
| Conditional Access policies  | 195        | Hard limit                   |
| Named Locations              | 195        | Hard limit                   |
| Administrative Units         | 5,000      | Hard limit                   |
| Custom roles                 | 200        | Hard limit                   |

### AD vs Entra ID at scale

| Scale scenario           | AD                                    | Entra ID  | Winner   |
| ------------------------ | ------------------------------------- | --------- | -------- |
| 1,000 users, single site | Excellent                             | Excellent | Tie      |
| 10,000 users, 5 sites    | Good (5+ DCs needed)                  | Excellent | Entra ID |
| 100,000 users, 50 sites  | Complex (50+ DCs, replication issues) | Excellent | Entra ID |
| 500,000 users, global    | Very complex (massive DC fleet)       | Excellent | Entra ID |

---

## 8. CSA-in-a-Box performance impact

### Identity overhead for platform operations

| CSA-in-a-Box operation                        | Identity overhead                        | Optimization                         |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| Fabric workspace access                       | 100--300 ms (first auth); 5--20 ms (SSO) | PRT caching; no per-request overhead |
| Databricks notebook execution                 | 100--200 ms (API token acquisition)      | Token cached for session duration    |
| Purview catalog browse                        | 50--150 ms (token validation)            | Cached tokens; minimal overhead      |
| Power BI report load                          | 100--300 ms (first auth); 0 ms (SSO)     | PRT-based SSO                        |
| ADLS Gen2 data access (managed identity)      | 10--50 ms (token acquisition)            | IMDS endpoint; local cache           |
| Key Vault secret retrieval (managed identity) | 10--50 ms                                | Cached in SDK                        |
| Graph API query (from application)            | 50--200 ms per query                     | Batch and delta queries              |

---

## 9. Availability and disaster recovery

### Service availability comparison

| Metric                                  | On-premises AD                   | Entra ID                       | Notes                                            |
| --------------------------------------- | -------------------------------- | ------------------------------ | ------------------------------------------------ |
| **SLA**                                 | No SLA (customer-managed)        | 99.99% (financially backed)    | Entra ID SLA covers authentication and directory |
| **Typical uptime**                      | 99.9--99.99% (well-managed)      | 99.99%+ (historical)           | AD depends on DC count, network, power           |
| **Recovery time (single DC failure)**   | 0 (other DCs serve)              | N/A                            | AD requires minimum 2 DCs per site               |
| **Recovery time (site failure)**        | 15 min--3 hours                  | 0 (global distribution)        | AD depends on inter-site replication             |
| **Recovery time (full forest failure)** | 4--24+ hours (forest recovery)   | N/A (Microsoft-managed)        | AD forest recovery is extremely complex          |
| **Backup frequency**                    | Customer-managed (daily typical) | Continuous (Microsoft-managed) | Entra ID is geo-redundant by design              |
| **Geographic distribution**             | Per-site DC placement            | Global PoPs (120+ worldwide)   | Entra ID routes to nearest PoP                   |

### Failover behavior

| Failure scenario       | AD behavior                                  | Entra ID behavior                        |
| ---------------------- | -------------------------------------------- | ---------------------------------------- |
| Single server failure  | Automatic failover to other DCs              | No impact (global service)               |
| Datacenter failure     | Failover to other site DCs (if available)    | Automatic failover to other regions      |
| Region failure         | May require manual intervention              | Automatic multi-region failover          |
| Certificate expiration | Authentication may fail (AD FS)              | Microsoft-managed; no customer action    |
| DNS failure            | Authentication fails (client cannot find DC) | Cached PRT continues to work for 14 days |
| Network partition      | Split-brain risk (AD replication conflict)   | No risk (cloud-native)                   |

### Offline operation

| Scenario                      | AD capability                            | Entra ID capability                                 |
| ----------------------------- | ---------------------------------------- | --------------------------------------------------- |
| Laptop offline (cached logon) | Last N cached credentials (default 10)   | PRT valid for 14 days; apps cached                  |
| Disconnected branch office    | Local DC serves authentication           | Cached PRT + local Kerberos cloud trust ticket      |
| Air-gapped network            | Full AD functionality                    | **Not supported** (Entra DS for isolated scenarios) |
| Internet outage at office     | Full AD functionality (if DCs are local) | Cached authentication works; new auth fails         |

---

## 10. Operational metrics comparison

### Day-to-day operations

| Operational task            | AD time investment            | Entra ID time investment                   | Savings |
| --------------------------- | ----------------------------- | ------------------------------------------ | ------- |
| User provisioning           | 15--30 min (manual)           | 2--5 min (HR-driven lifecycle)             | 80%     |
| Password reset (help desk)  | 5--15 min per incident        | 0 (SSPR/passwordless)                      | 100%    |
| Group membership update     | 5--10 min (manual)            | 0 (dynamic groups)                         | 100%    |
| New app SSO setup           | 4--8 hours (AD FS)            | 15--30 min (gallery app)                   | 94%     |
| Security log review         | 2--4 hours/day (manual)       | 30 min/day (Identity Protection automated) | 80%     |
| DC patching                 | 4--8 hours/month (per DC)     | 0 (Microsoft-managed)                      | 100%    |
| Certificate renewal         | 2--4 hours (per cert, annual) | 0 (Microsoft-managed)                      | 100%    |
| Replication troubleshooting | 2--8 hours/incident           | 0 (eliminated)                             | 100%    |

### Incident response comparison

| Incident type                 | AD MTTR                                          | Entra ID MTTR                                 | Improvement          |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------- | -------------------- |
| Compromised password          | 1--4 hours (identify + reset + investigate)      | 5--15 min (automatic detection + remediation) | 90%+                 |
| Brute force attack            | 1--2 hours (identify pattern, configure lockout) | 0 (automatic smart lockout)                   | 100%                 |
| Privileged account compromise | 2--8 hours (identify scope, revoke, rebuild)     | 15--30 min (PIM revocation + CA block)        | 90%                  |
| Token theft                   | N/A (Kerberos ticket valid until expiry)         | 1--5 min (CAE near-instant revocation)        | N/A (new capability) |

---

## 11. Cost-performance ratio

### Cost per authentication

| Environment                     | Monthly cost            | Monthly authentications | Cost per authentication |
| ------------------------------- | ----------------------- | ----------------------- | ----------------------- |
| On-prem AD (5,000 users, 4 DCs) | ~$15,000                | ~3,000,000              | $0.005                  |
| Entra ID (5,000 users, M365 E5) | ~$0 (included)          | ~3,000,000              | $0.000                  |
| Entra ID + Conditional Access   | ~$0 (included in P1/P2) | ~3,000,000              | $0.000                  |

### Infrastructure cost per 9 of availability

| Availability target        | AD infrastructure cost (annual)             | Entra ID cost (annual) |
| -------------------------- | ------------------------------------------- | ---------------------- |
| 99.9% (8.7 hours downtime) | $100K--$200K (2 DCs + monitoring)           | $0 (included)          |
| 99.99% (52 min downtime)   | $300K--$500K (4+ DCs, HA, monitoring)       | $0 (SLA-backed)        |
| 99.999% (5 min downtime)   | $500K--$1M+ (geo-distributed DCs, 24/7 NOC) | $0 (SLA-backed)        |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
