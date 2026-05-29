---
title: CIPSEA Operational Playbook for Azure
description: 14-step operational checklist for hosting CIPSEA-protected federal statistical workloads on Azure with CSA-in-a-Box. Covers agent designation, FedRAMP categorization, Disclosure Review Board workflow, and incident response.
---

# CIPSEA Operational Playbook for Azure

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

> **Audience:** Azure architects and federal data platform teams hosting workloads governed by [CIPSEA](cipsea.md) (44 U.S.C. §§ 3561–3583).
> **Companion:** [CIPSEA narrative + control crosswalk](cipsea.md) — read that first if you haven't.
> **Premise:** roughly 70% of CIPSEA technical requirements are inherited from FedRAMP Moderate (which CSA-in-a-Box implements). The remaining 30% is governance: agent designation, SDL review, CIPSEA-flavored incident response, OMB annual reporting. This playbook is the 30%.

The 14 steps below are sequenced so that the legal / governance prerequisites (steps 1–6) are settled *before* you build technical controls (steps 7–8) and *before* researchers or non-employee operators ever touch identifiable data (steps 9–14).

---

## 1. Confirm the data is actually CIPSEA-protected

Verify all four conditions of [44 U.S.C. § 3572(b)](https://www.govinfo.gov/content/pkg/USCODE-2022-title44/html/USCODE-2022-title44-chap35-subchapterIII.htm) hold:

- [ ] The collection instrument carried a confidentiality pledge.
- [ ] The pledged use is **exclusively statistical**.
- [ ] No other statute (Title 13, Title 26, HIPAA) is more restrictive — if so, defer to the more restrictive regime.
- [ ] The data is in **identifiable form** (CIPSEA stops protecting fully de-identified aggregates after [DRB approval](#8-stand-up-the-disclosure-review-board-drb-workflow)).

If any answer is "no" or "unsure", stop and consult the agency Confidentiality Officer before proceeding.

---

## 2. Verify your authority to designate agents

Per OMB 2007 guidance § VI, only [recognized statistical agencies and units](cipsea.md#the-16-recognized-statistical-agencies-and-units) can designate agents under CIPSEA standing alone. Non-statistical agencies (EPA, USGS, NOAA, etc.) acquiring data under a CIPSEA pledge **cannot** designate cloud-operator agents under CIPSEA without separate statutory authority.

- [ ] If your agency is one of the 16 recognized PSAs or Recognized Units → you can designate agents per § 3572.
- [ ] If your agency is *not* recognized → choose one of the two operational paths in [the narrative page](cipsea.md#non-statistical-agencies-acquiring-cipsea-protected-data): agency-employee-only access, or customer-managed-encryption + Confidential Computing to remove the cloud operator from the access chain.
- [ ] If your agency *is* recognized but you're contracting to a non-statistical operator → the contracting agency designates the operator's individuals as agents; your authority flows from the originating agency.

---

## 3. Categorize the system at FIPS-199 Moderate (default) or High

OMB 2007 guidance § V recommends FIPS-199 Moderate as the default for CIPSEA data.

- [ ] Default to **Moderate** unless you have a specific reason to go higher.
- [ ] Default to **High** if commingled with FTI (Title 26 / IRS Pub. 1075), if re-identification consequences are severe (e.g., small-population subgroups), or if your agency's risk acceptance requires it.
- [ ] Document the categorization rationale in the SSP — this is the hinge artifact for everything downstream.

The chosen baseline drives FedRAMP authorization requirements and the [NIST 800-53 r5](nist-800-53-rev5.md) control set.

---

## 4. Choose Azure Government (default) or Azure Commercial (US regions only)

There is **no statute mandating Azure Government** for CIPSEA. The recommendation is operational, not legal.

- [ ] Default to **Azure Government** for CIPSEA workloads in the reference architecture.
- [ ] Permit **Azure Commercial in US regions only** where the data is pure CIPSEA (no FTI commingling) and the agency's risk acceptance allows it.
- [ ] Apply Azure Policy `allowed-locations` to pin all storage and compute to US regions; ensure the policy assignment scopes to the CIPSEA workload's resource group, subscription, or management group as appropriate.
- [ ] **Never** place CIPSEA data in non-US Azure regions — the agent-designation regime is not practically enforceable against non-US Microsoft personnel.

---

## 5. Designate agents individually and in writing

This is the load-bearing legal step. **Each individual** who will have logical access to identifiable CIPSEA data — including cloud-operator personnel where applicable — must be named in advance.

For each prospective agent:

- [ ] Named in writing as an agent of the designating statistical agency.
- [ ] Signs an oath / nondisclosure affidavit acknowledging the [44 U.S.C. § 3572 criminal penalty](https://www.govinfo.gov/content/pkg/USCODE-2022-title44/html/USCODE-2022-title44-chap35-subchapterIII.htm) (Class E felony, up to 5 years and $250,000).
- [ ] Completes the agency's CIPSEA confidentiality training; certificate of completion retained.
- [ ] Background investigation appropriate to the FedRAMP baseline (Moderate → Tier 1 minimum; High → Tier 2 / Public Trust).
- [ ] Listed in the agency's annual OMB CIPSEA report (see [step 12](#12-annual-omb-cipsea-report)).

> **Microsoft does not blanket-sign CIPSEA agent agreements for Azure.** Per-individual designation is the model. Discuss with your Microsoft Federal account team how to scope Azure Government operator personnel to a screened pool and obtain individual designations — the same pattern that has been negotiated for IRS Pub. 1075 / FTI workloads. Treat the answer as agency-specific until you have it in writing.

BLS implementation reports document approximately **1,506 designated agents working under approximately 38 contracts** — agent designation is operationally feasible at scale, but it is *not* a corporate blanket.

---

## 6. Execute a contract or interagency agreement with all CIPSEA terms

For every contract, BAA, or interagency agreement covering work with identifiable CIPSEA data:

- [ ] Include the appendix language from [OMB 2007 guidance Appendix](https://www.federalregister.gov/documents/2007/06/15/E7-11542/implementation-guidance-for-title-v-of-the-e-government-act-confidential-information-protection-and): CIPSEA acknowledgment, agent obligations, audit rights, breach notification, return / destruction at end of contract.
- [ ] Reference 44 U.S.C. § 3572 by chapter and verse (avoids future ambiguity).
- [ ] Update the agency's standard procurement template so this language is applied by default to anything statistical-data-touching.
- [ ] If the contract involves a cloud provider, separately reach the per-individual agent designations from [step 5](#5-designate-agents-individually-and-in-writing) — the corporate contract does not substitute.

---

## 7. Build the technical control set on the FedRAMP baseline

> **Authoritative Microsoft references** for the underlying FedRAMP authorization that CSA-in-a-Box layers CIPSEA governance on top of:
>
> - [Microsoft Azure FedRAMP compliance offering](https://learn.microsoft.com/azure/compliance/offerings/offering-fedramp) — Azure Commercial FedRAMP High authorization
> - [Microsoft Azure Government FedRAMP](https://learn.microsoft.com/azure/azure-government/documentation-government-overview) — Azure Government FedRAMP High + DoD IL authorizations
> - [Microsoft Service Trust Portal](https://servicetrust.microsoft.com/) — per-Azure-service FedRAMP scope tables and audit reports
> - [Microsoft Azure Key Vault Managed HSM compliance](https://learn.microsoft.com/azure/key-vault/managed-hsm/managed-hsm-technical-details) — FIPS 140-2 L3 attestation
> - [Microsoft Azure Confidential Computing](https://learn.microsoft.com/azure/confidential-computing/overview) — TEE attestation documentation
>
> Cite the specific Azure service's entry in the Service Trust Portal in your SSP for any per-service control inheritance argument.

These controls go beyond stock NIST 800-53 r5 Moderate to satisfy CIPSEA's per-individual auditability requirement:

- [ ] **Customer-managed keys** in Azure Key Vault Managed HSM (FIPS 140-2 L3); key access logging to Sentinel.
- [ ] **Microsoft Entra ID Conditional Access** pinning agent accounts to compliant managed devices and US named locations.
- [ ] **Privileged Identity Management** with just-in-time elevation for any agent-level access; no standing privileged access to identifiable data.
- [ ] **Microsoft Sentinel + Log Analytics** with immutable retention (legal hold) for all data-plane access logs against identifiable data. Default retention: 7 years (matches the Records Disposition Schedule for most PSAs; verify against your agency's schedule).
- [ ] **Azure Confidential Computing** (Confidential VMs / SGX / SEV-SNP) where the threat model includes the cloud operator. **Required** for non-statistical-agency workloads where you cannot designate operator agents (see [narrative page](cipsea.md#non-statistical-agencies-acquiring-cipsea-protected-data)). **Recommended** for DRB workspaces.
- [ ] **Microsoft Defender for Cloud** with the FedRAMP Moderate (or High) compliance pack enabled; alerts routed to the agency Confidentiality Officer in addition to standard SOC.
- [ ] **No shared accounts**, no service-principal access to identifiable data: every access must be attributable to a named human agent.

---

## 8. Stand up the Disclosure Review Board (DRB) workflow

DRB is process, not just technology. Every output that leaves the secure enclave (microdata, tabulations, model coefficients, statistical artifacts) must be reviewed against the agency's Statistical Disclosure Limitation methods before release.

- [ ] **Identify the DRB members.** Typically: agency Confidentiality Officer (chair), 2–3 statistical methodologists, ISSO. NCHS uses a four-official approval chain (NCHS ISSO + NCHS Confidentiality Officer + CDC CISO + CDC CIO) for system authorization; DRB output approval is separate.
- [ ] **Document the SDL methods** the agency uses: cell suppression, swapping, top/bottom-coding, noise injection, formal differential privacy, synthetic data. BLS / BTS / NCHS use traditional methods; Census Bureau uses formal differential privacy for the decennial. Both are statutorily legitimate.
- [ ] **Build the workflow as a hard egress gate.** A pull request, Azure DevOps approval, or Microsoft 365 Approvals workflow tied to the secure enclave's egress storage account. No artifact leaves without DRB approval recorded.
- [ ] **Maintain the disclosure log** — every approved release with date, reviewer, methods applied, residual risk. This is what gets reported in the [annual OMB report](#12-annual-omb-cipsea-report).
- [ ] For modern threat-model awareness, reference the [Census Bureau modernization paper](https://www2.census.gov/adrm/CED/Papers/CY20/2020-009-AbowdBenedettoGarfinkelDahletal-The%20modernization%20of.pdf) on database-reconstruction attacks — traditional SDL is increasingly inadequate for high-cardinality microdata.

---

## 9. Implement the Standard Application Process integration if hosting researcher access

Per [OMB M-23-04](https://www.whitehouse.gov/wp-content/uploads/2022/12/M-23-04.pdf), external researcher applications for restricted-use data go through the SAP portal (operated by ICPSR / U-Mich); approved applicants then receive agency-specific security instructions.

- [ ] Build the Azure architecture to support **per-project enclaves** with isolated identity (separate Entra ID groups), network (separate VNets / private endpoints), and storage (separate ADLS Gen2 containers or accounts).
- [ ] Provision tear-down automation: at end of project the enclave is destroyed, keys rotated and old keys destroyed, all access logs preserved per retention schedule.
- [ ] Map to the [Census Bureau FSRDC virtual-enclave pattern](https://www.census.gov/about/adrm/fsrdc/about/secure-remote-access.html) for design inspiration.

---

## 10. Telework and remote-access controls

Mirror NCHS-style policy ([2024 implementation report](https://www.cdc.gov/nchs/policy/OMB-CIPSEA-Report-2025-508.pdf)):

- [ ] **50 states + DC only** for agent telework. Implement via Microsoft Entra Conditional Access named locations.
- [ ] **No open Wi-Fi** (cafés, airports, hotel lobbies). Mandate VPN or Azure Virtual Desktop access from agent-managed devices.
- [ ] **Agency-managed device or VDI thin client only** for any access to identifiable CIPSEA data. Personal devices: no.
- [ ] **Annual recertification** of agent telework eligibility; re-attestation logged in the agent record.
- [ ] Implement via Conditional Access named locations + Intune device compliance + Privileged Identity Management.

---

## 11. CIPSEA-disclosure incident response

Build a runbook branch off the standard FedRAMP IR plan (see [security-incident runbook](../runbooks/security-incident.md) for the base template):

- [ ] **Containment within 1 hour** of suspected disclosure — revoke agent access, pause data egress, snapshot state for forensics.
- [ ] **Notification to agency Confidentiality Officer within 1 hour** (parallel with containment, not after).
- [ ] **Notification to OMB** per agency procedures (typically within 24–72 hours; verify your agency's specific window).
- [ ] **Forensic preservation** for potential criminal referral under § 3572. Treat this as evidence handling: chain of custody, immutable storage, no tampering.
- [ ] **DRB consultation** if the disclosure was through a released product (suggests SDL failure — review and tighten methods).
- [ ] **Post-incident review** with corrective actions; update the agent training materials if human factors contributed.

The CIPSEA criminal penalty is real — agencies have prosecuted disclosures. Treat incidents accordingly.

---

## 12. Annual OMB CIPSEA report

Each agency that uses a CIPSEA pledge must annually report to OMB on:

- [ ] Information collections covered by the pledge (with citations to the OMB Control Numbers).
- [ ] Agents designated in the reporting year (count and contractual basis).
- [ ] Compliance with the 2007 guidance.
- [ ] Disclosure incidents (if any).
- [ ] SDL methods used and DRB activity summary.

Build the data collection for this into the Azure governance pipeline:

- [ ] **Azure Resource Graph** queries for the inventory of CIPSEA-tagged resources.
- [ ] **Microsoft Sentinel workbook** for the access-log summary.
- [ ] **Power BI report** template that consumes the above and produces the OMB report format.

Reference the [NCHS 2024 report](https://www.cdc.gov/nchs/policy/OMB-CIPSEA-Report-2025-508.pdf) and [BLS reports](https://www.bls.gov/bls/cipsea-report.htm) as format exemplars.

---

## 13. Data destruction at end of authorized purpose

Per OMB 2007 § V and standard agreement language, CIPSEA data held by an agent must be destroyed at end of the authorized purpose, and destruction must be certified.

- [ ] **Storage account lifecycle policy** to delete identifiable data N days after the documented end of authorized purpose (N defined per project).
- [ ] **Cryptographic erasure** for backups and replicas: rotate / destroy the customer-managed key that protected the data; confirm with key vault audit log.
- [ ] **Signed certificate of destruction** workflow (Microsoft 365 Approvals or Azure DevOps signed approval) attached to the agent record.
- [ ] **Verify backups and snapshots** are also covered — Azure Backup / point-in-time recovery snapshots can outlive the storage object if not configured to honor the lifecycle.

---

## 14. Re-identification risk assessment (PIA + DRB)

A privacy impact assessment specifically addressing re-identification risk should be conducted at:

- [ ] System authorization (initial ATO).
- [ ] Any major data product change (new microdata release, new tabulation method).
- [ ] Annual re-attestation in the OMB report.

Reference the [Census Bureau modernization papers](https://www2.census.gov/adrm/CED/Papers/CY20/2020-009-AbowdBenedettoGarfinkelDahletal-The%20modernization%20of.pdf) on database-reconstruction attacks for current threat-model thinking — traditional SDL methods are increasingly inadequate at scale, and the PIA should reflect that.

---

## Quick-start mapping by CSA-in-a-Box example

| If you're working on this csa-inabox example… | …apply this CIPSEA posture |
|---|---|
| [USDA NASS](../examples/usda.md) | NASS is a recognized PSA. Full agent-designation regime applies. Use Azure Government default. |
| [Commerce / BEA + Census](../examples/commerce.md) | BEA and Census are both recognized PSAs. Census data also subject to Title 13 (more restrictive) — defer to Title 13 pattern. |
| [EPA Environmental](../examples/epa.md) | Non-statistical agency. Use customer-managed-encryption + Confidential Computing pattern; do **not** rely on cloud-operator agent designation. |
| [NOAA Climate & Ocean](../examples/noaa.md) | Same as EPA — non-statistical, use the encryption-removal pattern. |
| [Tribal Health (IHS-aligned)](../examples/tribal-health.md) | NCHS-bound data may be CIPSEA + HIPAA — defer to HIPAA Security Rule technical controls; layer CIPSEA governance on top. |
| [Financial Fraud Detection](../examples/financial-fraud-detection.md) | BSA-AML data is *not* CIPSEA — this example is included for contrast. |

---

## Related

- **[CIPSEA narrative + control crosswalk](cipsea.md)** — statute background, three protections, NIST 800-53 mapping
- **[NIST 800-53 r5 mapping](nist-800-53-rev5.md)** — the FedRAMP Moderate baseline that CSA-in-a-Box implements (carries 70% of CIPSEA technical requirements)
- **[FedRAMP Moderate](fedramp-moderate.md)** — the cloud authorization regime CIPSEA effectively requires
- **[Government Service Matrix](../GOV_SERVICE_MATRIX.md)** — which Azure services are GA / preview / unavailable in Azure Government
- **[Security incident runbook](../runbooks/security-incident.md)** — base IR plan to fork for the [CIPSEA-disclosure variant](#11-cipsea-disclosure-incident-response)
- **[Best Practices — Security & Compliance](../best-practices/security-compliance.md)** — defense-in-depth patterns

---

**Last updated:** 2026-05-04
**Review cadence:** Annual (target: 2027-05-04)
**Owner:** csa-inabox platform team
