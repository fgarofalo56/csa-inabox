# HIPAA Security Rule — CSA Loom extension

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


How CSA Loom enables a customer's HIPAA Security Rule compliance.
Extends parent
[`docs/compliance/hipaa-security-rule.md`](../../compliance/hipaa-security-rule.md).

## HIPAA BAA scope

Microsoft Azure + Microsoft Power BI + Microsoft Purview are covered
under the Microsoft Product Terms HIPAA Business Associate Agreement
(BAA) across **Azure Commercial + Azure Government** boundaries.

CSA Loom is built entirely on these covered services, so the BAA
applies to the underlying infrastructure. **Customer must execute
the BAA with Microsoft** (typically via Enterprise Agreement or
Microsoft Customer Agreement).

## Customer responsibility

Loom enables; customer implements. The HIPAA Security Rule requires
the customer to:

- Apply MIP sensitivity labels to PHI (Loom's catalog overlay
  surfaces these but doesn't auto-classify PHI)
- Implement workload-level access controls (RLS / CLS on PHI tables)
- Ensure data minimization in Loom Data Agents (don't expose entire
  patient records to general-purpose agents)
- Apply audit-log retention per HIPAA (6 years minimum)
- Execute breach notification procedures
- Maintain workforce HIPAA training

## Loom contribution per Security Rule safeguard

### Administrative safeguards

| Safeguard | Loom contribution |
|---|---|
| Security Management Process (§164.308(a)(1)) | Defender for Cloud + Sentinel + per-workload risk assessment via Loom Monitoring Hub |
| Workforce Security (§164.308(a)(3)) | Entra-based workforce access; PIM for elevated roles |
| Information Access Management (§164.308(a)(4)) | Per-workspace Entra groups + per-engine RBAC + sensitivity labels |
| Security Awareness (§164.308(a)(5)) | Workshop curricula (PRP-22) include HIPAA-aware modules |
| Contingency Plan (§164.308(a)(7)) | DR pattern + RPO/RTO per component |
| Evaluation (§164.308(a)(8)) | Quarterly DR drill + Sentinel review |

### Physical safeguards

Inherited from Azure datacenter controls (Microsoft-managed).

### Technical safeguards

| Safeguard | Loom contribution |
|---|---|
| Access Control (§164.312(a)) | Entra MFA + PIM + OBO throughout Copilot |
| Audit Controls (§164.312(b)) | Activity Log + App Insights + LAW + Sentinel; 6-year retention configurable |
| Integrity (§164.312(c)) | TLS 1.2+ in transit; encryption at rest; signed container images |
| Person/Entity Authentication (§164.312(d)) | Entra ID with conditional access |
| Transmission Security (§164.312(e)) | TLS 1.2+; Private Endpoints; egress allow-list |

## PHI handling patterns in Loom

### Storing PHI

- Place PHI tables under a dedicated DLZ ("clinical-domain")
- Mark PHI columns with MIP sensitivity label (e.g., `Restricted-PHI`)
- Apply RLS to enforce per-user access by role
- Apply CLS to hide sensitive columns (SSN, MRN) from non-clinical
  users

### Mirroring PHI sources

- For SQL Server / Postgres / Oracle PHI sources, use Loom Mirroring
  Engine
- Mirroring runs under workspace UAMI; source must grant CDC read
- CDC stream lands in Bronze (sensitivity-labeled inherited from
  source)
- Apply transformations to redact non-essential PHI before Silver /
  Gold

### PHI in Loom Data Agents

- **Restrict** general-purpose Data Agents from PHI tables (set
  `sensitivityPolicy: "Block agent on tables tagged PHI"`)
- Create separate **clinical-domain agents** with explicit consent
  + audit
- Agent identity-passthrough (OBO) ensures only authorized clinicians
  see PHI in agent responses
- Sentinel rule monitors for agent attempts to access PHI by
  non-authorized users

### PHI in Loom Copilot

- Loom Copilot's PII redaction (existing `redaction.py`) covers PHI
  patterns (SSN, dates of birth, addresses)
- Per-turn telemetry logged; Sentinel detects abuse patterns
- In Gov, self-hosted Presidio side-car runs PHI detection BEFORE
  AOAI call

## Per-boundary HIPAA posture

| Boundary | HIPAA BAA | Loom-relevant notes |
|---|---|---|
| Commercial | ✅ | Full feature set; ideal for non-federal healthcare |
| GCC | ✅ | M365 GCC tenant for healthcare-specific federal data |
| GCC-High | ✅ | Strict federal healthcare (e.g., VHA classified workloads) |
| IL5 | ✅ | Limited use cases (federal healthcare classification rare) |

## Validation

Customer should:
1. Confirm BAA executed with Microsoft
2. Audit Loom Console "Catalog" to verify all PHI tables sensitivity-
   labeled
3. Audit Loom Data Agents config to verify PHI restrictions
4. Run Sentinel queries quarterly to verify access patterns
5. Test breach notification workflow

## Related

- Parent: [HIPAA Security Rule](../../compliance/hipaa-security-rule.md)
- Defender workaround: [Defender AI workaround](defender-ai-workaround.md)
- [Feature × boundary matrix](feature-boundary-matrix.md)
- Use case: Healthcare Clinical example port — [Healthcare](../examples/healthcare-clinical.md)
