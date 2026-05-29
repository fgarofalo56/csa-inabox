---
title: CIPSEA — Confidential Information Protection and Statistical Efficiency Act
description: How CSA-in-a-Box composes existing FedRAMP / NIST 800-53 controls with statute-specific governance to support CIPSEA-protected federal statistical workloads on Azure.
---

# CIPSEA — Confidential Information Protection and Statistical Efficiency Act

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


--8<-- "_includes/cipsea-draft-banner.md"

--8<-- "_includes/compliance-disclaimer.md"

> **Statute:** 44 U.S.C. §§ 3561–3583 (CIPSEA 2018, as amended by Title III of the Foundations for Evidence-Based Policymaking Act, Pub. L. 115-435; original enactment Title V of the E-Government Act of 2002, Pub. L. 107-347)
> **Operative interpretive guidance:** [72 Fed. Reg. 33362 (June 15, 2007) — OMB Implementation Guidance for CIPSEA, FR Doc. E7-11542](https://www.federalregister.gov/documents/2007/06/15/E7-11542/implementation-guidance-for-title-v-of-the-e-government-act-confidential-information-protection-and)
> **Default categorization:** FIPS-199 Moderate (per OMB 2007 guidance § V) → FedRAMP Moderate floor on Azure
> **Companion playbook:** [CIPSEA Operational Playbook](cipsea-playbook.md) — the 14-step "can I do this in Azure and how" checklist
> **Microsoft Azure CIPSEA documentation:** none exists publicly. CIPSEA is **not** a named Microsoft compliance offering. Compliance is built by composing existing FedRAMP / FISMA controls with agency-administered governance.

---

## Summary

CIPSEA is the principal federal statute protecting statistical data collected from respondents under a pledge of confidentiality. It applies to all federal agencies that collect such data — not only the 16 [recognized statistical agencies and units](#the-16-recognized-statistical-agencies-and-units) — and it imposes a **Class E felony** (up to 5 years in prison and a fine of up to $250,000 per violation) on any officer, employee, or agent who knowingly and willfully discloses CIPSEA-protected information in identifiable form (44 U.S.C. § 3572).

For an Azure architect, four facts are load-bearing:

1. **The criminal penalty attaches to individuals**, including cloud operator personnel who are "designated agents." Agent designation is *per-individual*, not corporate.
2. **OMB's recommended default FIPS-199 categorization is Moderate**, which effectively requires FedRAMP Moderate (or higher) for any cloud service in the boundary.
3. **Roughly 70% of CIPSEA's technical requirements are already covered** by the FedRAMP Moderate baseline that CSA-in-a-Box implements via [NIST 800-53 Rev. 5](nist-800-53-rev5.md). The remaining ~30% are governance gaps (agent agreements, SDL review, CIPSEA-flavored incident response, OMB annual reporting).
4. **Non-statistical agencies** (EPA, USGS, NOAA in our examples) can acquire CIPSEA-protected data but **cannot designate cloud-operator agents** under CIPSEA alone. They must rely on separate statutory authority or scope the boundary so no operator agent is needed.

CSA-in-a-Box's role is to ship the technical control set that satisfies the FedRAMP-derived 70% out of the box and to provide the [operational playbook](cipsea-playbook.md) and templates that close the governance 30%.

---

## The three core CIPSEA protections

CIPSEA establishes three protections that information acquired under a CIPSEA pledge enjoys (44 U.S.C. § 3572; OMB 2007 guidance § II–IV):

1. **Exclusively statistical use.** Data may not be used for any non-statistical purpose — administrative, regulatory, enforcement, investigative, or in any action against any individual or entity. An agency that pledged CIPSEA at collection cannot later repurpose the data for an enforcement action; doing so is itself a violation.

2. **Confidentiality.** The data may not be disclosed in identifiable form to anyone outside the statistical agency or its designated agents.

3. **Designation of agents.** Extension of the protection to non-employees (contractors, researchers, cloud operators, federal employees of other agencies) is permitted only via a written designation that imposes the same obligations and the same criminal penalty.

---

## The 16 recognized statistical agencies and units

CIPSEA 2018 (the Evidence Act re-codification) recognizes 16 statistical agencies and units (44 U.S.C. § 3562). Thirteen are designated **Principal Statistical Agencies** (PSAs); three are additional **Recognized Units**.

| # | Agency / unit | Department |
|---|---|---|
| 1 | Bureau of Economic Analysis (BEA) | Commerce |
| 2 | Bureau of Justice Statistics (BJS) | Justice / OJP |
| 3 | Bureau of Labor Statistics (BLS) | Labor |
| 4 | Bureau of Transportation Statistics (BTS) | Transportation |
| 5 | U.S. Census Bureau | Commerce |
| 6 | Economic Research Service (ERS) | Agriculture |
| 7 | Energy Information Administration (EIA) | Energy |
| 8 | National Agricultural Statistics Service (NASS) | Agriculture |
| 9 | National Center for Education Statistics (NCES) | Education / IES |
| 10 | National Center for Health Statistics (NCHS) | HHS / CDC |
| 11 | National Center for Science and Engineering Statistics (NCSES) | NSF |
| 12 | Office of Research, Evaluation, and Statistics (ORES) | SSA |
| 13 | Statistics of Income Division (SOI) | Treasury / IRS |
| 14 | Microeconomic Surveys Unit | Federal Reserve Board |
| 15 | Center for Behavioral Health Statistics and Quality | HHS / SAMHSA |
| 16 | National Animal Health Monitoring System (NAHMS) | USDA / APHIS |

This list directly intersects several CSA-in-a-Box [end-to-end examples](../examples/index.md): NASS / ERS / NAHMS at USDA, Census + BEA at Commerce, SOI at Treasury. EPA and NOAA are *not* recognized statistical agencies but can still acquire data under a CIPSEA pledge — see [non-statistical agencies, below](#non-statistical-agencies-acquiring-cipsea-protected-data).

---

## When data is CIPSEA-protected

Per 44 U.S.C. § 3572(b) and the 2007 OMB guidance, data is CIPSEA-protected when **all four** of the following are true:

1. It is acquired by a Federal agency,
2. From a respondent (individual, household, or organization),
3. Under a pledge of confidentiality,
4. For exclusively statistical purposes.

**Statistical purpose** (§ 3561) means the description, estimation, or analysis of the characteristics of groups, *without* identifying the individuals or organizations that comprise such groups. **Statistical activities** include collection, compilation, processing, analysis, and dissemination of data and analytical results for statistical purposes.

### When CIPSEA stops protecting data

CIPSEA protects information **in identifiable form**. Once data has been processed through a Statistical Disclosure Limitation (SDL) review and a Disclosure Review Board (DRB) determines the released product cannot identify any respondent, the released aggregates are no longer CIPSEA-protected for purposes of further dissemination. **The underlying microdata remains CIPSEA-protected indefinitely.**

Modern complication: traditional SDL methods (cell suppression, swapping, top-coding) have been shown inadequate against database-reconstruction attacks at scale. The Census Bureau's [2020 modernization papers](https://www2.census.gov/adrm/CED/Papers/CY20/2020-009-AbowdBenedettoGarfinkelDahletal-The%20modernization%20of.pdf) document the move to formal differential-privacy methods. Other PSAs (BLS, BTS, NCHS) continue to use traditional SDL. Both pathways are operationally legitimate.

### What disqualifies data from CIPSEA

If at the time of collection the agency intends *or pledges* any non-statistical use (regulatory, administrative, enforcement, investigatory), the data is not CIPSEA-protected — and it cannot be retrofitted onto data that was collected under a non-statistical pledge. This means a single ingest stream cannot serve both regulatory and statistical purposes if a CIPSEA pledge is on the form.

!!! note "There is no statutory CIPSEA Tier 1/2/3 system"
    The Commission on Evidence-Based Policymaking (2017) recommended a tiered-access model that informed the Evidence Act, but the **statute does not codify numbered tiers**. Agency materials sometimes describe public-use / restricted-use / secure-enclave-only data products — that is operational practice, not a statutory classification.

---

## Interaction with other confidentiality statutes

CIPSEA operates alongside several other confidentiality regimes. **The more restrictive regime always governs the data element in question.**

| Other statute | Where CIPSEA fits |
|---|---|
| **Title 13 (Census Act)** | Title 13 governs Census Bureau data and is more restrictive than CIPSEA in several respects (including the 72-year rule). |
| **Title 26 (FTI / IRS)** | IRS Statistics of Income is a CIPSEA agency, but data commingled with Federal Tax Information is governed by [IRS Pub. 1075](https://www.irs.gov/pub/irs-pdf/p1075.pdf) — which effectively requires FedRAMP High and tighter operator controls than CIPSEA. |
| **HIPAA Security Rule** | NCHS data may be both HIPAA-covered and CIPSEA-protected. The more restrictive of the two governs. See [HIPAA mapping](hipaa-security-rule.md). |
| **Privacy Act of 1974** | OMB has explicitly noted that once data is pledged under CIPSEA, "some of the routine uses permitted under the Privacy Act would no longer be allowed because they are not for statistical purposes" (2007 guidance, response to comments). CIPSEA narrows Privacy Act routine-use disclosures. |

---

## Cloud / Azure-specific requirements

### Azure Government vs Azure Commercial

**There is no statute or OMB guidance that mandates Azure Government for CIPSEA workloads.** What constrains the choice in practice:

- The OMB 2007 guidance does not explicitly require US-only data residency, but the agent-personnel restrictions effectively impose a US-residency posture on any system the agents touch. NCHS, for example, [restricts agent telework to the 50 states + DC](https://www.cdc.gov/nchs/policy/OMB-CIPSEA-Report-2025-508.pdf).
- The recommended FIPS-199 Moderate categorization is satisfied by both Azure Commercial and Azure Government per Microsoft's formal FedRAMP authorizations: see [Microsoft Azure FedRAMP compliance offering](https://learn.microsoft.com/azure/compliance/offerings/offering-fedramp) (FedRAMP High authorization for Azure and Azure Government) and the per-service FedRAMP scope tables in [Microsoft Service Trust Portal](https://servicetrust.microsoft.com/). DoD IL2 / IL4 / IL5 authorizations for Azure Government are documented at [Microsoft Azure DoD compliance offering](https://learn.microsoft.com/azure/compliance/offerings/offering-dod-il5).
- **In practice** every PSA cloud strategy publicly documented uses a government-cloud or FedRAMP High posture for CIPSEA data, even though the statute permits Moderate. Reasons: cohabitation with FTI workloads (which require IL5 / FedRAMP High); personnel screening and citizenship requirements that Azure Government can satisfy via screened-US-persons-only operations; reduced supply-chain risk under EO 14028 / EO 14110.

**CSA-in-a-Box recommendation:** default the reference architecture to **Azure Government** for CIPSEA workloads. Document that **Azure Commercial (US regions only)** is statutorily permissible for pure CIPSEA-only data with no FTI commingling and where the agency's risk acceptance allows it. Pin all storage and compute to US regions via Azure Policy `allowed-locations`.

### Encryption, KMS, audit logging — what CIPSEA adds beyond NIST baseline

CIPSEA itself does not specify encryption algorithms or HSM requirements; these inherit from NIST 800-53 Rev. 5 Moderate baseline (SC-12, SC-13, SC-28, AU-2, AU-3, AU-12) which CSA-in-a-Box already implements. What CIPSEA *does* impose beyond stock NIST baseline:

- **Agent access logging** — every access to identifiable CIPSEA data must be auditable to the named individual agent. This pushes toward customer-managed keys (CMK) with key access logging, identity-bound access via Microsoft Entra ID Privileged Identity Management, and immutable audit log retention. Azure Key Vault Managed HSM with diagnostic logs to Microsoft Sentinel / Log Analytics with immutability policies is the natural pattern.
- **Confidential Computing** (Azure Confidential VMs, SGX, SEV-SNP) is *not required* by CIPSEA but is an emerging best practice for re-identification-attack defense, particularly for DRB environments where the protected data must be processed without exposure to the cloud operator. Recommended where the threat model includes the cloud provider as an adversary — and the standard pattern for non-statistical agencies that cannot designate cloud-operator agents.

### Non-statistical agencies acquiring CIPSEA-protected data

EPA, USGS, NOAA, and any other non-statistical federal agency can acquire data under a CIPSEA pledge — but they **cannot designate cloud-operator agents** under CIPSEA alone (per OMB 2007 guidance § VI; § 3573 powers attach only to recognized statistical agencies and units).

Two operational paths for a non-statistical agency:

- **Agency-employee-only access.** Restrict logical access to identifiable CIPSEA data to agency employees only; no cloud-operator agent designation. Operationally hard in IaaS — every break-glass operator action by Microsoft personnel breaks the model.
- **Customer-managed encryption + Confidential Computing.** Render the data unreadable to the cloud operator at all times, removing the operator from the access chain. CMK in Azure Key Vault Managed HSM with no Microsoft access path; processing in Confidential VMs / SGX enclaves with attestation. This is the scalable Azure pattern.

This is the most genuinely unsettled area of CIPSEA cloud architecture. CSA-in-a-Box's reference implementation for EPA / NOAA examples uses path 2 (CMK + Confidential Computing) by default for any data that may be CIPSEA-protected.

---

## Control crosswalk — CIPSEA → NIST 800-53 Rev. 5 → CSA-in-a-Box

There is no formal publicly available CIPSEA-to-NIST 800-53 Rev. 5 crosswalk. The mapping below is derived from the CIPSEA statute, the 2007 OMB guidance, and PSA implementation reports (notably [NCHS 2024](https://www.cdc.gov/nchs/policy/OMB-CIPSEA-Report-2025-508.pdf) and [BLS](https://www.bls.gov/bls/cipsea-report.htm)). It identifies which CIPSEA requirements CSA-in-a-Box already satisfies via its FedRAMP Moderate / NIST 800-53 baseline, and where the residual governance gaps are.

| CIPSEA requirement | Source | NIST 800-53 Rev. 5 control families | CSA-in-a-Box coverage |
|---|---|---|---|
| Designate agents in writing; bind to oath and criminal penalty | 44 U.S.C. § 3572; OMB 2007 § IV | AC-2, AC-5, AC-6, PS-2, PS-3, PS-6, PS-7 | Largely covered by FedRAMP Moderate; **gap**: PS-6 access agreements need CIPSEA-specific language (oath, criminal-penalty acknowledgment) — see [playbook step 5](cipsea-playbook.md#5-designate-agents-individually-and-in-writing) |
| Audit every access by a named individual to identifiable CIPSEA data | OMB 2007 § V | AU-2, AU-3, AU-6, AU-9, AU-12 | Covered; configuration must ensure non-repudiable identity binding (no shared accounts, MFA-bound to agent identity) |
| Encryption in transit and at rest | OMB 2007 § V; FIPS-199 Moderate default | SC-8, SC-13, SC-28, SC-12 | Covered |
| FIPS-199 Moderate categorization (default) | OMB 2007 § V | RA-2 | Covered (FedRAMP Moderate); document override rationale if categorizing Higher |
| Confidentiality pledge on collection instrument; cannot be repurposed | 44 U.S.C. § 3572; OMB 2007 § II | PT-2, PT-3, PT-5 | Partial — privacy notice templates exist but need CIPSEA-pledge variant |
| Statistical Disclosure Limitation review before any release | OMB 2007 § VII; Census DRB practice | PT-7, SI-12, AC-21 | **Gap** — no SDL/DRB workflow control in current CSA-in-a-Box; see [playbook step 8](cipsea-playbook.md#8-stand-up-the-disclosure-review-board-drb-workflow) |
| Incident reporting for unauthorized disclosure | OMB 2007 § V; NIST SP 800-122 | IR-4, IR-6, IR-8 | IR family covered by FedRAMP Moderate; **gap**: incident playbook needs a CIPSEA-disclosure variant with OMB / Confidentiality Officer reporting paths and criminal-referral consideration |
| Physical and logical media protection; secure destruction at end of authorized purpose | OMB 2007 § V | MP-2, MP-4, MP-6, MP-7 | Covered |
| Contracts with agents must include CIPSEA terms | OMB 2007 Appendix | SA-4, SA-9, PS-7 | **Gap** — procurement template needs CIPSEA contract clause |
| Annual reporting to OMB on use of pledge and agents | OMB 2007 § VIII; NCHS exemplar | CA-2, CA-7, PM-31 | Partial — continuous-monitoring framework present, no CIPSEA report template |
| US data residency / personnel locality | NCHS practice; OMB 2007 (physical security) | SA-9(5), AC-3 | **Gap** — Azure Policy `allowed-locations` is straightforward but not currently scoped to a CIPSEA workload class |
| Re-identification risk assessment (DRB / PIA) | Census / NCHS practice; OMB SDL guidance | RA-3, RA-8, PT-4, PT-7 | **Gap** — no PIA template tuned to disclosure-risk for statistical microdata |

**Pattern:** roughly **70% of CIPSEA technical requirements** are inherited directly from the FedRAMP Moderate baseline. The remaining **30% are governance/process gaps** (agent agreements, SDL review, CIPSEA-flavored incident response, OMB annual reporting). The [operational playbook](cipsea-playbook.md) covers the gap.

---

## Existing public agency practice

The richest publicly available CIPSEA implementation patterns come from PSAs that have published their compliance posture:

- **Census Bureau — [Federal Statistical Research Data Centers (FSRDC)](https://www.census.gov/about/adrm/fsrdc.html)**: 37 physical centers nationwide, all backed by Census Bureau VDI hosted at the Bowie, MD Computer Center, recently extended to remote access from approved home worksites with annual video inspection. The FSRDC architecture is the gold-standard physical pattern that any CSA-in-a-Box virtual-enclave reference architecture should map to.
- **Census Bureau — [OCIO Cloud Services PIA (FY23, SAOP-approved)](https://www.commerce.gov/sites/default/files/2024-04/OCIO-Cloud-Services_PIA_FY23_SAOP_Approved.pdf)**: centralized framework using FedRAMP-authorized CSPs. Publicly named providers include AWS GovCloud (used for the 2020 Census decennial data collection) and Google Cloud. Microsoft Azure is not listed in the public PIA; Azure IaaS use for CIPSEA data at Census is not publicly documented.
- **BLS — [CIPSEA Implementation Reports](https://www.bls.gov/bls/cipsea-report.htm)**: documents approximately **1,506 designated agents working under approximately 38 contracts** with private vendors. Useful concrete data point: agent designation is operationally feasible at scale, but it requires per-individual paperwork, training, and oath — *not* a corporate blanket.
- **NCHS — [Annual OMB CIPSEA Report CY 2024](https://www.cdc.gov/nchs/policy/OMB-CIPSEA-Report-2025-508.pdf)**: the most operationally detailed PSA disclosure publicly available. Documents a "CIPSEA Compliant System" approval process (NCHS ISSO + NCHS Confidentiality Officer + CDC CISO + CDC CIO), telework restricted to 50 states + DC, open Wi-Fi prohibited, annual recertification. This is the best public template for how a federal-statistical PSA actually operationalizes CIPSEA in a modern hybrid-cloud environment.

---

## Known unsettled areas

A handful of CIPSEA cloud-architecture questions do not have settled public answers as of this page's preparation. Address with your agency Confidentiality Officer and Microsoft Federal account team rather than treating as solved:

- **Whether Microsoft will sign per-individual CIPSEA agent agreements for Azure Government operators.** No public documentation either confirms or denies this. The IRS Pub. 1075 precedent (where Microsoft signs a Safeguards Agreement and provides screened-US-persons-only operator personnel for FTI tenants) suggests a path, but CIPSEA-specific arrangements would need to be negotiated.
- **Whether FedRAMP Moderate is sufficient or High is effectively required.** Statute says Moderate by default; PSA practice trends toward High when commingled with FTI or when re-identification consequences are severe.
- **How CIPSEA interacts with [EO 14117](https://www.federalregister.gov/documents/2024/03/01/2024-04308/preventing-access-to-americans-bulk-sensitive-personal-data-and-united-states-government-related) (preventing access to bulk sensitive personal data by countries of concern).** EO 14117 (Feb 2024) and the DOJ implementing rule create new restrictions on bulk data transactions. CIPSEA-protected data is plausibly "sensitive personal data" within EO 14117's scope. No public guidance has yet aligned the two regimes.
- **Whether OMB will issue refreshed CIPSEA implementation guidance** to replace the 2007 document. Anticipated by some PSA implementation reports but not announced as of preparation date.

---

## Next steps

- **Read the [operational playbook](cipsea-playbook.md)** for the 14-step "can I host this in Azure and how" checklist.
- **If your workload also touches FTI**, defer to [IRS Pub. 1075](https://www.irs.gov/pub/irs-pdf/p1075.pdf) — it is more restrictive than CIPSEA on cloud and effectively governs.
- **For non-statistical-agency CIPSEA acquisitions** (EPA / USGS / NOAA examples), see the [Customer-managed encryption + Confidential Computing pattern](#non-statistical-agencies-acquiring-cipsea-protected-data) above.
- **Verify your control posture** against the [NIST 800-53 r5 mapping](nist-800-53-rev5.md) — that's where most CIPSEA technical controls actually live.

---

## References

**Statute and regulation:**

- [44 U.S.C. §§ 3561–3583 — CIPSEA 2018](https://www.govinfo.gov/content/pkg/USCODE-2022-title44/html/USCODE-2022-title44-chap35-subchapterIII.htm)
- [Pub. L. 107-347 — E-Government Act of 2002 (CIPSEA original)](https://www.govinfo.gov/content/pkg/STATUTE-116/pdf/STATUTE-116-Pg2899.pdf)
- [Pub. L. 115-435 — Foundations for Evidence-Based Policymaking Act of 2018](https://www.congress.gov/bill/115th-congress/house-bill/4174/text/eas)
- [72 Fed. Reg. 33362 (June 15, 2007) — OMB Implementation Guidance for CIPSEA, FR Doc. E7-11542](https://www.federalregister.gov/documents/2007/06/15/E7-11542/implementation-guidance-for-title-v-of-the-e-government-act-confidential-information-protection-and)
- [OMB M-23-04 — Standard Application Process](https://www.whitehouse.gov/wp-content/uploads/2022/12/M-23-04.pdf)
- [88 Fed. Reg. 56353 (Aug. 18, 2023) — Fundamental Responsibilities of Recognized Statistical Agencies and Units](https://www.federalregister.gov/documents/2023/08/18/2023-17664/fundamental-responsibilities-of-recognized-statistical-agencies-and-units)

**Agency implementation reports:**

- [BLS CIPSEA Implementation Reports](https://www.bls.gov/bls/cipsea-report.htm)
- [NCHS Annual OMB CIPSEA Report CY 2024](https://www.cdc.gov/nchs/policy/OMB-CIPSEA-Report-2025-508.pdf)
- [NCES CIPSEA Report](https://nces.ed.gov/statprog/CIPSEA_Report.asp)
- [BTS Confidentiality Policy](https://www.bts.gov/confidentiality)
- [ERS CIPSEA Training](https://www.ers.usda.gov/sites/default/files/images/cipseatraining.pdf)
- [EIA 2016 CIPSEA Report](https://www.eia.gov/about/pdfs/2016_cipsea_report.pdf)
- [Census Bureau OCIO Cloud Services PIA (FY23)](https://www.commerce.gov/sites/default/files/2024-04/OCIO-Cloud-Services_PIA_FY23_SAOP_Approved.pdf)
- [Census FSRDC program](https://www.census.gov/about/adrm/fsrdc.html)

**Background and cross-reference:**

- [Wikipedia — CIPSEA](https://en.wikipedia.org/wiki/Confidential_Information_Protection_and_Statistical_Efficiency_Act)
- [CRS Report R48161 — The Federal Statistical System: An Overview](https://www.congress.gov/crs-product/R48161)
- [National Academies — CIPSEA at 15 Years](https://sites.nationalacademies.org/cs/groups/dbassesite/documents/webpage/dbasse_179564.pdf)
- [Abowd et al. — The Modernization of Statistical Disclosure Limitation at the Census Bureau](https://www2.census.gov/adrm/CED/Papers/CY20/2020-009-AbowdBenedettoGarfinkelDahletal-The%20modernization%20of.pdf)
- [Statistical Policy Working Paper 22 — SDL Report (FCSM)](https://nces.ed.gov/FCSM/pdf/SPWP22_rev.pdf)
- [Azure Government for Federal](https://azure.microsoft.com/en-us/explore/global-infrastructure/government/federal)

---

**Last updated:** 2026-05-04
**Review cadence:** Annual (target: 2027-05-04)
**Owner:** csa-inabox platform team
