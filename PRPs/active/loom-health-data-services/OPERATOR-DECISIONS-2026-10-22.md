# LHDS — operator decisions recorded 2026-10-22

Answers given in chat by the operator after reading the planning summary. These supersede the
"recommended default" column in `RISKS-AND-OPEN-DECISIONS.md` wherever they differ. Where an answer
differs from the recommended default, the consequence is stated so a later reader sees why a wave
has an extra constraint.

## Scope decisions made before the PRD was written (unchanged)

1. Engines: Loom owns the platform; FHIR and DICOM protocol engines are proven OSS picked by evidence (ADR-001, ADR-002).
2. Boundaries: Commercial and GCC-High with per-cloud receipts, designed so IL5 / DoD is configuration.
3. Sequencing: FHIR core first to ship, DICOM as a parallel track from wave 1.
4. Scale: deployment stamps with a shared control plane.
5. Legacy ingest in v1: HL7 v2 and C-CDA to FHIR; VistA / RPMS as adapter specs.
6. Analytics in v1: Bulk FHIR export, de-identification, lakehouse sink.
7. Terminology: free vocabularies bundled; SNOMED / UMLS customer-licensed.
8. Compliance mapped: HIPAA; NIST 800-53 High / FedRAMP High; 42 CFR Part 2; HITRUST; VA / IHS authorization evidence. Mapping only, no ATO claim.

## Decisions recorded 2026-10-22

| Id | Question | Answer | Consequence for the plan |
|---|---|---|---|
| Q3 / D2 | License posture for the public repo | MPL/LGPL acceptable, AGPL not acceptable | dcm4chee-arc-light is allowed unmodified-where-possible. Orthanc (AGPL plugins) is OFF the table, even as an isolated service. If dcm4chee fails the W0 pass bar, the fallback is a Loom-built DICOMweb-on-Blob service modelled on microsoft/dicom-server (MIT, archived branch). ADR-002 fallback ordering changes accordingly. |
| Q2 | W0 budget | Small spike, about $4k | One class-S stamp, Commercial only, a smaller synthetic cohort. W0 applies the engine pass bars and closes the Gov availability questions. Scale claims stay estimates until a later, separately approved larger run; the capacity model's class-M numbers are NOT validated by W0. |
| Q1 | Where the first GCC-High stamp lives | The SAME GCC-High subscription Loom Gov already uses | Differs from the recommended default (decide after W0). Consequences to carry: PHI workloads share an RBAC, policy and quota boundary with Loom's own platform resources; audit scoping for authorization packages is harder; quota requests (PostgreSQL E-series / SSD v2 in US Gov Virginia) draw on the shared subscription; W1 must put the health stamp in its own resource groups with its own policy assignments and a deny-by-default network posture so the boundary can later be split out without redesign. Revisit if W0 shows quota contention or a customer asks for a dedicated subscription. |
| D3 / Q6 | DoD boundary | Add in W1 as its own small bicep PR | Add 'DoD' to the bicep boundary enum and a dod.bicepparam, supported-in-code only, never claimed exercised. Touches every param file, so it is its own PR and obeys the one-bicep-PR-in-flight rule. |
| D4 | Stamp mapping | VA one stamp per VISN (18, tenant = VISN); IHS 4 stamps by Area group (tenant = Area); Commercial one per customer region | As recommended. |
| D10 / Q5 | VistA / RPMS adapters | Spec documents only; no code until an agency partner provides test access | As recommended. Adapter specs stay marked UNVERIFIED. |
| D21 | 42 CFR Part 2 labeled records in the lakehouse sink | Excluded by default; per-tenant opt-in with labels | As recommended. |
| Q9 | Owner and date for the IL5 lane receipt | None; keep IL5 listed as supported-in-code, never exercised | As recommended. Every per-cloud table in the plan marks IL5 as unexercised and links here. |

## Accepted as the plan's defaults (not asked; operator may change)

Q4 Loom does not become a SNOMED affiliate; Q10 keep the name Loom Health Data Services; D1 FHIR engine and D2 DICOM engine are CONFIRMED only by the W0 receipt against the pass bar; D18 auto-pause is OFF for production health stamps and ON for sandbox stamps (health data stores are data-loss adjacent); every other D5-D27 default stands.

## Work the orchestrator owns that these answers imply

- Q7: verify whether the private lakehouse workspace-isolation advisory fix is deployed on every estate the sink will run on (the `health-lakehouse-isolation` gate blocks the sink until it is). Not yet verified in this session.
- Q8: the Gov image lanes still have no Trivy / cosign gate (#4584). W1 must include that lane fix before any Gov stamp image ships.
