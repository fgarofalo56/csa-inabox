# Exchange On-Premises vs Exchange Online: Total Cost of Ownership Analysis

**Status:** Authored 2026-04-30
**Audience:** CFOs, CIOs, procurement officers, and IT directors evaluating the financial case for Exchange Online migration.
**Methodology:** Cost models use published Microsoft licensing (EA/MPSA), vendor hardware list pricing, and representative labor rates for federal and commercial organizations. All numbers are illustrative and should be validated against your specific contracts and environment.

---

## How to read this document

Every cost section includes:

- **On-premises baseline** --- the current Exchange infrastructure cost.
- **Exchange Online equivalent** --- the cloud licensing and operational cost.
- **Delta** --- the net savings or additional cost.
- **Hidden costs** --- expenses that on-premises budgets typically undercount.

Three reference architectures are modeled: Small (250 mailboxes), Medium (2,500 mailboxes), and Large (25,000 mailboxes).

---

## 1. On-premises Exchange cost model

### Hardware and infrastructure

#### Small organization (250 mailboxes)

| Component                          | Specification                                                | Cost (5-year amortized/yr) |
| ---------------------------------- | ------------------------------------------------------------ | -------------------------- |
| Exchange servers (2-node DAG)      | Dell PowerEdge R750, 2x Xeon Gold, 256 GB RAM, 8x 2.4 TB SAS | $16,000/yr                 |
| Storage (JBOD for DAG)             | Included in server spec (JBOD preferred for DAG)             | Included                   |
| Load balancer                      | Kemp LM-3400 or F5 i2600                                     | $3,000/yr                  |
| UPS + PDU                          | APC Smart-UPS 3000VA (2x)                                    | $1,200/yr                  |
| Rack space + power + cooling       | 4U per server, 8U total                                      | $4,800/yr                  |
| Network (switches, firewall rules) | Allocated share of network infrastructure                    | $2,000/yr                  |
| **Hardware subtotal**              |                                                              | **$27,000/yr**             |

#### Medium organization (2,500 mailboxes)

| Component                                | Specification                                                 | Cost (5-year amortized/yr) |
| ---------------------------------------- | ------------------------------------------------------------- | -------------------------- |
| Exchange servers (4-node DAG)            | Dell PowerEdge R750, 2x Xeon Gold, 512 GB RAM, 16x 2.4 TB SAS | $32,000/yr                 |
| Edge Transport servers (2)               | Dell PowerEdge R650, 1x Xeon Silver, 64 GB RAM                | $6,000/yr                  |
| Load balancer (HA pair)                  | F5 i4600 HA pair                                              | $8,000/yr                  |
| SAN or JBOD expansion                    | Additional storage for archive mailboxes                      | $5,000/yr                  |
| DR site (passive DAG members, 2 servers) | Same spec as primary, co-located                              | $16,000/yr                 |
| UPS + PDU + cooling                      | Enterprise-grade                                              | $3,000/yr                  |
| Rack space (primary + DR)                | 16U primary, 8U DR                                            | $12,000/yr                 |
| Network infrastructure                   | Dedicated VLAN, firewall rules, WAN link to DR                | $6,000/yr                  |
| **Hardware subtotal**                    |                                                               | **$88,000/yr**             |

#### Large organization (25,000 mailboxes)

| Component                                  | Specification                                 | Cost (5-year amortized/yr) |
| ------------------------------------------ | --------------------------------------------- | -------------------------- |
| Exchange servers (16-node DAG, multi-site) | Dell/HPE enterprise servers across 2--3 sites | $128,000/yr                |
| Edge Transport servers (4)                 | Perimeter mail relay                          | $12,000/yr                 |
| Load balancers (F5 HA per site)            | F5 i5800 HA pairs                             | $24,000/yr                 |
| Storage infrastructure                     | SAN or JBOD for 50+ TB mailbox data           | $30,000/yr                 |
| DR infrastructure (full site)              | Geo-redundant DAG members + network           | $64,000/yr                 |
| Network (WAN, ExpressRoute equivalent)     | Multi-site connectivity                       | $18,000/yr                 |
| Rack space + power + cooling (multi-site)  | 40U+ across sites                             | $36,000/yr                 |
| **Hardware subtotal**                      |                                               | **$312,000/yr**            |

### Software licensing (on-premises)

| License                                            | Small (250)    | Medium (2,500)  | Large (25,000)    |
| -------------------------------------------------- | -------------- | --------------- | ----------------- |
| Windows Server Datacenter (per 2-core pack)        | $6,000/yr      | $18,000/yr      | $72,000/yr        |
| Exchange Server Standard (per server)              | $3,600/yr      | $7,200/yr       | $28,800/yr        |
| Exchange Server Enterprise (per server, if needed) | $0             | $2,400/yr       | $9,600/yr         |
| Exchange CALs (Standard, per user)                 | $5,000/yr      | $50,000/yr      | $500,000/yr       |
| Exchange Enterprise CALs (per user, if needed)     | $0             | $25,000/yr      | $250,000/yr       |
| SQL Server (for Edge Transport, monitoring)        | $2,000/yr      | $4,000/yr       | $8,000/yr         |
| Backup software (Veeam/Commvault)                  | $3,000/yr      | $12,000/yr      | $60,000/yr        |
| Anti-spam/anti-malware (Proofpoint/Mimecast)       | $5,000/yr      | $37,500/yr      | $312,500/yr       |
| SSL/TLS certificates (SAN certs)                   | $500/yr        | $1,500/yr       | $4,000/yr         |
| Monitoring (SCOM or third-party)                   | $2,000/yr      | $8,000/yr       | $24,000/yr        |
| **Software subtotal**                              | **$27,100/yr** | **$165,600/yr** | **$1,268,900/yr** |

### Personnel costs

| Role                          | Small (250)        | Medium (2,500)     | Large (25,000)     |
| ----------------------------- | ------------------ | ------------------ | ------------------ |
| Exchange admin (FTE)          | 0.25 FTE ($27,500) | 1.0 FTE ($110,000) | 4.0 FTE ($440,000) |
| Windows Server admin (shared) | 0.1 FTE ($11,000)  | 0.25 FTE ($27,500) | 1.0 FTE ($110,000) |
| Network admin (shared)        | 0.05 FTE ($5,500)  | 0.1 FTE ($11,000)  | 0.5 FTE ($55,000)  |
| Security admin (shared)       | 0.05 FTE ($5,500)  | 0.1 FTE ($11,000)  | 0.5 FTE ($55,000)  |
| Backup admin (shared)         | 0.05 FTE ($5,500)  | 0.1 FTE ($11,000)  | 0.25 FTE ($27,500) |
| Help desk (Exchange-related)  | 0.1 FTE ($8,000)   | 0.5 FTE ($40,000)  | 2.0 FTE ($160,000) |
| **Personnel subtotal**        | **$63,000/yr**     | **$210,500/yr**    | **$847,500/yr**    |

### Hidden costs (typically undercounted)

| Hidden cost                                              | Small (250)    | Medium (2,500)  | Large (25,000)  |
| -------------------------------------------------------- | -------------- | --------------- | --------------- |
| Emergency patching labor (Hafnium-class)                 | $5,000/yr      | $20,000/yr      | $80,000/yr      |
| CU testing and deployment (quarterly)                    | $4,000/yr      | $16,000/yr      | $64,000/yr      |
| Compliance audit labor (annual)                          | $3,000/yr      | $12,000/yr      | $48,000/yr      |
| Incident response (security)                             | $2,000/yr      | $8,000/yr       | $40,000/yr      |
| Vendor support contracts                                 | $5,000/yr      | $15,000/yr      | $60,000/yr      |
| Training and certification                               | $2,000/yr      | $6,000/yr       | $20,000/yr      |
| Opportunity cost (admin time on maintenance vs projects) | $10,000/yr     | $40,000/yr      | $160,000/yr     |
| **Hidden cost subtotal**                                 | **$31,000/yr** | **$117,000/yr** | **$472,000/yr** |

### Total on-premises cost

| Category             | Small (250)  | Medium (2,500) | Large (25,000) |
| -------------------- | ------------ | -------------- | -------------- |
| Hardware             | $27,000      | $88,000        | $312,000       |
| Software             | $27,100      | $165,600       | $1,268,900     |
| Personnel            | $63,000      | $210,500       | $847,500       |
| Hidden costs         | $31,000      | $117,000       | $472,000       |
| **Total on-prem/yr** | **$148,100** | **$581,100**   | **$2,900,400** |
| **Per-mailbox/yr**   | **$592**     | **$232**       | **$116**       |

---

## 2. Exchange Online cost model

### Licensing options

| License                     | Per-user/month | Includes                                                        | Best for                          |
| --------------------------- | -------------- | --------------------------------------------------------------- | --------------------------------- |
| Exchange Online Plan 1      | $4.00          | 50 GB mailbox, basic compliance                                 | Frontline workers                 |
| Exchange Online Plan 2      | $8.00          | 100 GB mailbox, unlimited archive, DLP, eDiscovery              | Knowledge workers (standalone)    |
| Microsoft 365 E3            | $36.00         | EXO P2 + Office apps + Teams + SharePoint + compliance baseline | Most organizations                |
| Microsoft 365 E5            | $57.00         | E3 + Defender for O365 P2 + Purview Premium + Copilot-ready     | Security/compliance-focused       |
| Microsoft 365 F1            | $2.25          | Frontline; limited mailbox (2 GB)                               | Shift workers, kiosks             |
| Microsoft 365 F3            | $8.00          | Frontline; 2 GB mailbox + Office web apps                       | Frontline with collaboration      |
| Microsoft 365 G3 (GCC)      | $32.00         | Government E3 equivalent                                        | Federal civilian                  |
| Microsoft 365 G5 (GCC)      | $57.00         | Government E5 equivalent                                        | Federal civilian (security focus) |
| Microsoft 365 G5 (GCC-High) | $60.00         | GCC-High E5 equivalent                                          | DoD, ITAR, CUI                    |

### Exchange Online total cost

#### Small organization (250 users, M365 E3)

| Component                       | Cost/yr      |
| ------------------------------- | ------------ |
| M365 E3 licenses (250 x $36/mo) | $108,000     |
| M365 admin labor (0.1 FTE)      | $11,000      |
| Migration (one-time, FastTrack) | $0           |
| Training (one-time, amortized)  | $2,000       |
| **Total EXO/yr**                | **$121,000** |
| **Per-user/yr**                 | **$484**     |

#### Medium organization (2,500 users, M365 E3)

| Component                                            | Cost/yr        |
| ---------------------------------------------------- | -------------- |
| M365 E3 licenses (2,500 x $36/mo)                    | $1,080,000     |
| M365 admin labor (0.5 FTE)                           | $55,000        |
| Migration (one-time, FastTrack)                      | $0             |
| Third-party tools (migration accelerator, if needed) | $5,000         |
| **Total EXO/yr**                                     | **$1,140,000** |
| **Per-user/yr**                                      | **$456**       |

#### Large organization (25,000 users, mixed E3/E5/F3)

| Component                                    | Cost/yr         |
| -------------------------------------------- | --------------- |
| M365 E5 licenses (5,000 x $57/mo)            | $3,420,000      |
| M365 E3 licenses (15,000 x $36/mo)           | $6,480,000      |
| M365 F3 licenses (5,000 x $8/mo)             | $480,000        |
| M365 admin labor (2.0 FTE)                   | $220,000        |
| Migration (one-time, amortized over 2 years) | $100,000        |
| **Total EXO/yr**                             | **$10,700,000** |
| **Per-user/yr**                              | **$428**        |

!!! info "M365 includes more than email"
The M365 E3/E5 license cost includes Exchange Online, Teams, SharePoint Online, OneDrive, Office desktop apps, Intune, Entra ID P1/P2, Purview baseline compliance, and more. Comparing the full M365 E3 price against Exchange-only on-prem cost overstates the delta. The fair comparison isolates Exchange Online Plan 2 ($8/user/month = $96/user/year) against the on-prem Exchange cost.

### Fair comparison: Exchange-only costs

| Metric                        | Small (250)  | Medium (2,500) | Large (25,000) |
| ----------------------------- | ------------ | -------------- | -------------- |
| On-prem Exchange total/yr     | $148,100     | $581,100       | $2,900,400     |
| On-prem per-mailbox/yr        | $592         | $232           | $116           |
| EXO Plan 2 only (per-user/yr) | $96          | $96            | $96            |
| EXO Plan 2 total/yr           | $24,000      | $240,000       | $2,400,000     |
| EXO + admin labor/yr          | $35,000      | $295,000       | $2,620,000     |
| **Net savings/yr**            | **$113,100** | **$286,100**   | **$280,400**   |
| **Savings %**                 | **76%**      | **49%**        | **10%**        |

!!! note "Economies of scale"
Small organizations see the largest savings percentage because on-prem infrastructure costs are fixed (you need at least 2 servers for HA regardless of mailbox count). Large organizations see smaller percentage savings because per-user licensing cost is relatively flat while on-prem achieves better utilization. However, large organizations gain the most from hidden cost elimination (security incidents, patching labor, compliance audit).

---

## 3. Five-year TCO projection

### Small organization (250 mailboxes)

| Year               | On-premises                        | Exchange Online (EXO P2 + admin)   | Cumulative delta   |
| ------------------ | ---------------------------------- | ---------------------------------- | ------------------ |
| Year 0 (migration) | $148,100                           | $50,000 (migration + partial year) | +$98,100           |
| Year 1             | $148,100                           | $35,000                            | +$211,200          |
| Year 2             | $155,000 (hardware refresh starts) | $36,000                            | +$330,200          |
| Year 3             | $160,000                           | $37,000                            | +$453,200          |
| Year 4             | $165,000 (full refresh cycle)      | $38,000                            | +$580,200          |
| **5-year total**   | **$776,200**                       | **$196,000**                       | **$580,200 saved** |

### Medium organization (2,500 mailboxes)

| Year               | On-premises    | Exchange Online (EXO P2 + admin)    | Cumulative delta     |
| ------------------ | -------------- | ----------------------------------- | -------------------- |
| Year 0 (migration) | $581,100       | $350,000 (migration + partial year) | +$231,100            |
| Year 1             | $581,100       | $295,000                            | +$517,200            |
| Year 2             | $610,000       | $303,000                            | +$824,200            |
| Year 3             | $640,000       | $312,000                            | +$1,152,200          |
| Year 4             | $670,000       | $321,000                            | +$1,501,200          |
| **5-year total**   | **$3,082,200** | **$1,581,000**                      | **$1,501,200 saved** |

### Large organization (25,000 mailboxes)

| Year               | On-premises     | Exchange Online (EXO P2 + admin)      | Cumulative delta     |
| ------------------ | --------------- | ------------------------------------- | -------------------- |
| Year 0 (migration) | $2,900,400      | $2,800,000 (migration + partial year) | +$100,400            |
| Year 1             | $2,900,400      | $2,620,000                            | +$380,800            |
| Year 2             | $3,050,000      | $2,700,000                            | +$730,800            |
| Year 3             | $3,200,000      | $2,780,000                            | +$1,150,800          |
| Year 4             | $3,350,000      | $2,860,000                            | +$1,640,800          |
| **5-year total**   | **$15,400,800** | **$13,760,000**                       | **$1,640,800 saved** |

---

## 4. Cost optimization strategies

### Right-size licensing

- **Frontline workers (F1/F3):** Shift workers, manufacturing floor, retail --- $2.25--$8.00/user/month instead of $36.
- **Shared mailboxes:** Free in Exchange Online (no license required for shared mailboxes that are not logged into directly).
- **Room/equipment mailboxes:** Free (no license required).
- **Archive mailboxes:** Included with EXO Plan 2 and E3/E5 (unlimited archive).

### Negotiate EA pricing

- Federal organizations typically achieve 15--25% discount on published list pricing through Enterprise Agreements (EA) or MPSA.
- GCC pricing is typically 5--10% higher than commercial due to sovereign infrastructure costs.
- Multi-year commitments (3-year EA) provide additional discount leverage.

### Phase the migration

- License users in batches aligned with migration waves to avoid paying for unused licenses.
- Use Exchange Online Plan 1 ($4/user/month) for users who do not need DLP/eDiscovery, upgrade to Plan 2 or E3/E5 when compliance features are needed.

### Eliminate third-party spend

Exchange Online with E5 eliminates the need for separate:

- Anti-spam/anti-malware gateway (Proofpoint, Mimecast) --- replaced by EOP + Defender for Office 365.
- Email archiving (Enterprise Vault, Barracuda) --- replaced by Exchange Online Archiving.
- DLP (Symantec DLP, Digital Guardian) --- replaced by Microsoft Purview DLP.
- eDiscovery (Relativity, Nuix for email) --- replaced by Purview eDiscovery Premium.

For the medium organization, third-party elimination saves $37,500--$75,000/year.

---

## 5. Migration cost considerations

### FastTrack (free)

- Available for 150+ seat tenants.
- Covers migration planning, hybrid configuration, mailbox moves.
- No charge for data migration (email, calendar, contacts).
- Does not cover: public folders > 100 GB, third-party archive migration, custom integrations.

### Third-party migration tools (if needed)

| Tool                              | Cost             | Use case                                    |
| --------------------------------- | ---------------- | ------------------------------------------- |
| BitTitan MigrationWiz             | $12--$25/mailbox | Third-party archive migration, multi-source |
| Quest On Demand Migration         | $10--$20/mailbox | Tenant-to-tenant, complex hybrid            |
| AvePoint                          | Custom pricing   | Large enterprise, compliance-sensitive      |
| Native (Exchange migration batch) | $0               | Standard hybrid/cutover/staged              |

### Internal labor for migration

| Phase                      | Small (250)   | Medium (2,500) | Large (25,000)  |
| -------------------------- | ------------- | -------------- | --------------- |
| Planning and assessment    | 40 hours      | 120 hours      | 400 hours       |
| Hybrid setup               | 16 hours      | 40 hours       | 80 hours        |
| Pilot migration            | 16 hours      | 40 hours       | 120 hours       |
| Production migration       | 24 hours      | 120 hours      | 600 hours       |
| DNS cutover and validation | 8 hours       | 24 hours       | 80 hours        |
| Decommission               | 8 hours       | 24 hours       | 120 hours       |
| **Total labor**            | **112 hours** | **368 hours**  | **1,400 hours** |
| **Labor cost (@ $100/hr)** | **$11,200**   | **$36,800**    | **$140,000**    |

---

## 6. ROI summary

| Metric                          | Small (250) | Medium (2,500) | Large (25,000) |
| ------------------------------- | ----------- | -------------- | -------------- |
| Migration cost (one-time)       | $11,200     | $36,800        | $240,000       |
| Annual on-prem cost             | $148,100    | $581,100       | $2,900,400     |
| Annual EXO cost (Exchange-only) | $35,000     | $295,000       | $2,620,000     |
| Annual savings                  | $113,100    | $286,100       | $280,400       |
| Payback period                  | 1.2 months  | 1.5 months     | 10.3 months    |
| 5-year ROI                      | 5,080%      | 3,980%         | 584%           |
| 5-year total savings            | $580,200    | $1,501,200     | $1,640,800     |

---

## 7. Federal-specific cost considerations

### GCC pricing

- GCC licensing is typically 5--10% higher than commercial.
- M365 G3 (GCC): ~$32/user/month.
- M365 G5 (GCC): ~$57/user/month.
- FastTrack is available for GCC at no additional cost.

### GCC-High pricing

- GCC-High licensing is 10--20% higher than commercial.
- M365 G5 (GCC-High): ~$60/user/month.
- Dedicated infrastructure costs are embedded in licensing.
- FastTrack for GCC-High requires pre-authorization engagement.

### DoD pricing

- DoD licensing is comparable to GCC-High.
- Dedicated IL5 infrastructure.
- Procurement through DISA or authorized resellers.

### Federal acquisition vehicles

| Vehicle                              | Notes                                           |
| ------------------------------------ | ----------------------------------------------- |
| GSA MAS (IT Schedule 70)             | Standard federal acquisition for M365 licensing |
| NASA SEWP                            | Alternative acquisition vehicle                 |
| DISA milCloud                        | DoD-specific procurement                        |
| Enterprise Software Initiative (ESI) | DoD/IC blanket purchase agreements              |
| BPA (Blanket Purchase Agreement)     | Agency-specific volume agreements               |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
