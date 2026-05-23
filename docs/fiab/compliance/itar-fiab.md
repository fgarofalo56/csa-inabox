# ITAR — CSA Loom extension

ITAR (International Traffic in Arms Regulations) governs the export of
defense articles and services. Federal contractors handling ITAR data
must use audit boundaries that prevent export.

## Boundary suitability

| Boundary | ITAR-eligible? |
|---|---|
| Commercial | ❌ |
| GCC | ❌ |
| GCC-High | ✅ |
| IL5 | ✅ |

CSA Loom deployments handling ITAR data must run in **GCC-High** or
**IL5** (v1.1).

## Customer responsibility

Loom enables; customer implements ITAR-specific controls:

- Identify ITAR data via Purview sensitivity labels (or Atlas tags at
  IL5)
- Apply RLS / CLS to restrict access to US-person workforce
- Verify cross-cloud B2B is disabled OR scoped per ITAR policy (no
  foreign-person collaboration)
- Configure Sentinel rules to detect ITAR-data egress patterns
- Document Technology Control Plan (TCP) covering Loom + workloads
- Workforce ITAR training (annual)
- Maintain workforce nationality verification (US-person status)

## How Loom helps

### Identification

- **Purview classification** rules can be authored to detect ITAR-
  related data patterns (controlled-tech keywords, export-controlled
  part numbers, etc.)
- Custom classification scheme: `ITAR-Restricted` label
- Console "Catalog" pane surfaces ITAR-labeled assets

### Access control

- Per-workspace Entra groups limited to US-person workforce only
- Conditional Access policies enforce US-person verification
- OBO throughout Copilot — every action attributed to a verified
  US-person identity

### Network egress

- Azure Firewall app rules block egress to non-US-person destinations
- Cross-cloud B2B disabled or scoped per ITAR policy
- Private Endpoints prevent public-internet exposure of ITAR data

### Audit

- LAW + Sentinel retention configured per ITAR policy (typically
  7 years)
- Sentinel rules detect:
  - ITAR-tagged data accessed by user not in US-person Entra group
  - Cross-cloud B2B invitation involving ITAR scope
  - Data export attempt (download to non-Loom endpoint)
  - Loom Copilot answering ITAR-related questions

### Encryption

- TLS 1.2+ in transit
- Encryption at rest (HSM-CMK at IL5; recommended at GCC-H)
- Signed container images (cosign per release)

## Cross-cloud restrictions (ITAR-specific)

Cross-cloud B2B (Entra ID Cross-Cloud Settings) bridges Commercial +
Gov tenants. For ITAR workloads:
- **Disable cross-cloud B2B** for the ITAR-scoped DLZ entirely; OR
- **Tightly scope** to a narrow allow-list of pre-vetted US-person
  identities in the partner cloud

The Hybrid Fabric Commercial + Loom Gov topology described in
[Hybrid topology](../use-cases/hybrid-topology.md) is **NOT
appropriate for ITAR-scoped workloads** unless the cross-cloud
identity is rigorously controlled.

## Loom workspace patterns for ITAR

### Pattern 1: ITAR-only DLZ

- Dedicate a DLZ subscription to ITAR workloads
- Apply DLZ-level Entra group restriction (US-persons only)
- No cross-DLZ data flows to non-ITAR DLZs

### Pattern 2: Mixed-classification DLZ with strict RLS

- DLZ holds both ITAR and non-ITAR data
- ITAR tables marked with sensitivity label + RLS predicate
- RLS predicate: `WHERE GROUP_MEMBER('ITAR-US-Persons')`

Pattern 1 is preferred for clean audit boundaries.

## Loom Copilot + ITAR

- Apply `sensitivityPolicy: "Block agent on tables tagged ITAR-
  Restricted"` to general-purpose agents
- Create separate ITAR-specific Data Agent with explicit user
  authentication + audit
- Agent prompt instruction: "Refuse to answer questions involving
  export-controlled technical data unless requester is verified US
  person"
- Sentinel monitors for ITAR-relevant prompts

## Customer ITAR checklist

- [ ] Loom deployed in GCC-High or IL5 only
- [ ] All workforce US-person status verified (annual)
- [ ] ITAR sensitivity labels applied via Purview / Atlas
- [ ] Per-workspace Entra groups restricted to US-persons
- [ ] Cross-cloud B2B disabled or scoped per ITAR policy
- [ ] Sentinel ITAR-egress rules deployed + tested
- [ ] Annual ITAR workforce training documented
- [ ] Technology Control Plan covers Loom + workloads
- [ ] Quarterly compliance review

## Related

- Parent: [ITAR](../../compliance/itar.md)
- [GCC-High / IL4](gcc-high.md), [DoD IL5](dod-il5.md)
- [Feature × boundary matrix](feature-boundary-matrix.md)
