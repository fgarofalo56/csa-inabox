# CMMC 2.0 Level 2 — CSA Loom extension

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


How CSA Loom contributes to a customer's CMMC 2.0 Level 2 (or Level
3) audit posture. Extends parent
[`docs/compliance/cmmc-2.0-l2.md`](../../compliance/cmmc-2.0-l2.md).

## CMMC 2.0 in scope

| Level | Audience | Practice families |
|---|---|---|
| L1 | Small contractors | 17 practices (basic safeguarding) |
| L2 | Most CUI handlers | 110 practices (NIST 800-171 r2 alignment) |
| L3 | High-criticality | 130+ practices (NIST 800-171 + 800-172 enhancements) |

CSA Loom's strongest fit is **L2** in GCC-High / IL4 — federal
contractors processing CUI. L3 is feasible at IL5 (v1.1).

## Why GCC-High and not GCC

CMMC L2/L3 typically requires:
- FedRAMP Moderate or High baseline (Azure Government meets)
- ITAR-eligible boundary (GCC-High; not GCC)
- Customer-managed deploy (no persistent vendor access)

GCC runs on Azure Commercial — doesn't satisfy ITAR. **CMMC L2/L3
defense industrial base customers should deploy CSA Loom in
GCC-High.**

## How Loom helps (practice family mapping)

### AC — Access Control (22 practices in L2)

| Practice | Loom contribution |
|---|---|
| AC.L2-3.1.1 Limit access | Entra ID + per-workspace groups + workspace UAMI |
| AC.L2-3.1.5 Least privilege | PIM-eligible MCP MI; standing Reader only |
| AC.L2-3.1.13 Remote access | Private Endpoints; no public endpoints |
| AC.L2-3.1.20 External system connections | OneLake shortcuts require explicit configuration + audit |

### AT — Awareness & Training (3 practices)

Customer responsibility (Loom contributes workshop curricula).

### AU — Audit & Accountability (9 practices)

| Practice | Loom contribution |
|---|---|
| AU.L2-3.3.1 Create audit logs | LAW + Sentinel ingest |
| AU.L2-3.3.4 Audit log review | Sentinel workbook + custom KQL queries |
| AU.L2-3.3.8 Audit log retention | 1 year minimum at GCC-H |
| AU.L2-3.3.9 Authorized audit access | LAW RBAC restricts read |

### CM — Configuration Management (9 practices)

| Practice | Loom contribution |
|---|---|
| CM.L2-3.4.1 Baseline configuration | Bicep + Git is the baseline |
| CM.L2-3.4.2 Configure security | `.bicepparam` per-boundary enforces secure defaults |
| CM.L2-3.4.6 Least functionality | Service-by-service feature flags; only deploy what's needed |
| CM.L2-3.4.9 User-installed software control | Container images locked to versioned tags; ACR signing |

### IA — Identification & Authentication (11 practices)

| Practice | Loom contribution |
|---|---|
| IA.L2-3.5.1 Identify users | Entra ID end-to-end |
| IA.L2-3.5.3 MFA | Conditional Access policy enforced by customer |
| IA.L2-3.5.7 Password complexity | Entra ID policy + customer policy |
| IA.L2-3.5.10 Crypto-protected passwords | Entra ID; no Loom-managed passwords |

### IR — Incident Response (3 practices)

| Practice | Loom contribution |
|---|---|
| IR.L2-3.6.1 Incident handling capability | Sentinel + Loom runbook library |
| IR.L2-3.6.2 Incident reporting | Sentinel automation rules + Logic App routing |

### MA — Maintenance (6 practices)

| Practice | Loom contribution |
|---|---|
| MA.L2-3.7.1 Maintenance plan | Quarterly upgrade cadence per release-please |
| MA.L2-3.7.2 Remote maintenance | MCP-as-update-channel pattern (PIM-elevated, audit-logged) |
| MA.L2-3.7.5 Establish controls for remote maintenance | OBO throughout; every action attributed |

### MP — Media Protection (9 practices)

| Practice | Loom contribution |
|---|---|
| MP.L2-3.8.1 Protect CUI media | ADLS Gen2 encryption + RBAC + Private Endpoints |
| MP.L2-3.8.9 Protect CUI in transit | TLS 1.2+ |

### PE — Physical Protection (6 practices)

Inherited from Azure Government physical controls (FedRAMP H baseline).

### PS — Personnel Security (2 practices)

Customer responsibility.

### RA — Risk Assessment (3 practices)

Loom contributes:
- Defender for Cloud (per-workload plans)
- Sentinel correlation + threat hunting
- DR drill exercises

### SC — System & Communications Protection (16 practices)

| Practice | Loom contribution |
|---|---|
| SC.L2-3.13.1 Boundary protection | Hub-spoke + Private Endpoints + Azure Firewall |
| SC.L2-3.13.5 Public network access | `publicNetworkAccess = disabled` on all PaaS |
| SC.L2-3.13.8 Transmit and store CUI separately | Per-DLZ network + storage isolation |
| SC.L2-3.13.11 Cryptographic mechanisms | TLS 1.2+; HSM-CMK at IL5 |
| SC.L2-3.13.16 Protect CUI at rest | ADLS Gen2 encryption + sensitivity labels |

### SI — System & Information Integrity (7 practices)

| Practice | Loom contribution |
|---|---|
| SI.L2-3.14.1 Identify, report, correct flaws | Defender for Cloud + customer patching cadence |
| SI.L2-3.14.5 Periodic scans | Defender for Containers (AKS); ACR vulnerability scanning |
| SI.L2-3.14.6 Monitor security events | Sentinel + Loom Copilot SOC pipeline |
| SI.L2-3.14.7 Identify unauthorized use | Sentinel analytics rules + cross-workspace exfiltration detection |

## What customer must add

Loom doesn't satisfy CMMC alone. Customer must:
- Document SSP (System Security Plan) covering Loom + their
  workloads
- Implement personnel security controls
- Provide CMMC L2 / L3 training to staff
- Execute incident response procedures
- Schedule + conduct internal assessments
- Engage CMMC C3PAO for third-party assessment (L2+) or government
  assessor (L3)

## Related

- Parent: [CMMC 2.0 Level 2](../../compliance/cmmc-2.0-l2.md)
- [Feature × boundary matrix](feature-boundary-matrix.md)
- [GCC-High / IL4](gcc-high.md)
- External: [CMMC 2.0 official scope](https://dodcio.defense.gov/CMMC/)
