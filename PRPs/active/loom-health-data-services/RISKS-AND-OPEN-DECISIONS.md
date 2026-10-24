# LHDS — Risks, open decisions (D1-D27) and operator-only questions

Execution proceeds on the **recommended default** unless the operator answers
before the wave that depends on it starts. Nothing here blocks W0.

## 1. Decisions with recommended defaults

| # | Decision | Recommended default | Options | Needed by |
|---|---|---|---|---|
| D1 | FHIR engine | HAPI FHIR JPA (Apache-2.0), Medplum fallback (ADR-001); fixed by the W0 receipt against the pass bar | (a) as recommended; (b) Medplum primary; (c) Microsoft fhir-server + Azure SQL (drops PostgreSQL) | W2 |
| D2 | DICOM engine and licence posture | dcm4chee-arc-light under MPL/LGPL terms, unmodified where possible (ADR-002); Orthanc only as an isolated AGPL service if dcm4chee fails W0; Loom-built DICOMweb-on-Blob (modelled on archived MIT dicom-server) as the long-term fallback | (a) as recommended; (b) Orthanc primary with AGPL review; (c) build our own from the start | W3 |
| D3 | DoD boundary | Add `'DoD'` to the bicep `boundary` enum and a `dod.bicepparam` as supported-in-code only, never claimed exercised (`main.bicep:20` lacks it today) | (a) add now in W1; (b) defer, document "not deployable"; (c) fold DoD into IL5 params | W1 |
| D4 | Stamp alignment | VA: one stamp per VISN (18), tenant = VISN; IHS: 4 stamps grouping Areas, tenant = Area; Commercial: per customer region | per facility; per region only; per Area (12) | W1 |
| D5 | Edge | App Gateway WAF v2 per stamp everywhere; Front Door Premium optional in Commercial/Gov AZ-TX | Front Door everywhere (Virginia unverified) | W1 |
| D6 | Router | APIM classic Premium (existing `apimSku`) in front of stamps once > 1 stamp; stamp ingress for single-stamp | APIM from day one | W1 |
| D7 | Redis | In-cluster Valkey (BSD-3) | Azure Managed Redis once it has a Gov audit row | W3 |
| D8 | SNOMED affiliate licence | Customer-loaded only; Loom does not become a SNOMED affiliate distributor in v1 | Loom affiliate licence with sub-licence tracking | W4 |
| D9 | Terminology bundle list | ADR-013 bundled set (LOINC, UCUM, THO, ICD-10-CM/PCS, HCPCS II, CVX/MVX, NDC, MED-RT, RxNorm Prescribable, HGNC, NCIt) | add/remove per legal review | W4 |
| D10 | VistA / RPMS adapter depth | Spec documents only; no code until an agency partner provides test access | spike against public VistA (WorldVistA) images | W5 |
| D11 | MPI matching | Deterministic on enterprise identifiers; review queue for candidates; no probabilistic matching | evaluate OpenEMPI-class matching in W11 with measured precision/recall on synthetic data | W6 |
| D12 | Health admin capability | New `Health Tenant Admin` capability, not inherited from Loom Admin | inherit | W1 |
| D13 | Patient-facing identity | Entra External ID where available per cloud; B2B otherwise; disclosed per cloud | tenant-issued patient accounts only | W1 |
| D14 | Field-level encryption | None in v1; SSN stored only hashed | selective field encryption | W2 |
| D15 | Managed HSM | Key Vault Premium default; Managed HSM as a bicep option (no separate Gov audit row — unverified) | Managed HSM default at IL5 | W1 |
| D16 | Ingest transcoding | Store as received; optional lifecycle transcoding to lossless HTJ2K/JPEG 2000 later | transcode at ingest | W3 |
| D17 | Long-term FHIR backup | Weekly logical export per tenant to immutable Blob, 7 years | 35-day PITR only | W1 |
| D18 | Auto-pause | Off for production stamps, on for sandbox stamps | on everywhere with guards | W1 |
| D19 | IHE Connectathon participation | Not in v1; scripted WIA/IID behaviours only | participate in year 2 | W3 |
| D20 | Full-text search | Out of v1; lakehouse/AI Search path | self-hosted OpenSearch on stamp | W7 |
| D21 | Labeled (Part 2) data in the sink | Excluded by default; include-with-labels per tenant opt-in | always include with labels | W6 |
| D22 | AI inference on images | Out of scope | later wave | — |
| D23 | FHIR R5 | Not in v1 | HAPI R5 per tenant | — |
| D24 | `_not-referenced` and other AHDS-only params | Not in v1 | implement in W7 | W7 |
| D25 | OMOP | Not in v1; later wave from Silver tables | — | — |
| D26 | Confidential node pools | Not in v1 (GA in Gov 2026-03, regions unnamed) | optional node pool at IL5 | W11 |
| D27 | Subscriptions | Topic-based subscriptions (R4 backport) in W7 | R4 classic subscriptions | W7 |

## 2. Questions only the operator can answer

| # | Question | Why it matters | Default if unanswered |
|---|---|---|---|
| Q1 | Which Gov subscription/tenant hosts the LHDS GCC-High stamp, and does it have PostgreSQL E-series + SSD v2 quota in US Gov Virginia? | W0 availability closure and W1 bicep | W0 reports the quota probe result; no stamp until answered |
| Q2 | Budget ceiling for W0 (engine load tests at the 1 M cohort in Commercial, ~1 class-M stamp for ~2 weeks, order of $12-15 k) and for the first Gov stamp | Cost rules in `MASTER-INDEX.md` | **Resolved 2026-10-24 (operator): decide on DEV evidence.** W0-7 ran on the DEV receipts (#5107) with no class-S spend ($0 Azure). ADRs move off Proposed on function proof, and every throughput or latency pass bar DEV could not establish is carried to W7's class-M receipts (`W0-RECEIPT.md` s8) |
| Q3 | Licence posture: is MPL/LGPL use of dcm4chee acceptable for the public csa-inabox repo, and is AGPL (Orthanc plugins) acceptable as an isolated service? | D2 | MPL/LGPL yes, AGPL no |
| Q4 | Will Loom become a SNOMED affiliate (sub-licence tracking obligations)? | D8 | No |
| Q5 | Are VA/IHS agency partners available to validate the VistA/RPMS adapter specs and provide HL7 v2 samples? | D10 | Specs marked unverified |
| Q6 | DoD: add the boundary now (D3)? | bicep enum change touches every param file (bicep collision rule) | Add in W1 as its own small bicep PR |
| Q7 | GHSA-g7m7 (lakehouse workspace isolation): is the fix deployed on every estate the sink will run on? | ADR-016 prerequisite; the `health-lakehouse-isolation` gate blocks the sink until it is | Sink disabled until confirmed |
| Q8 | Trivy/cosign on the Gov image lanes (#4584): can W1 include that lane fix (it is a shared workflow, outside LHDS ownership)? | Gov stamps cannot ship unsigned images (`SECURITY-AND-COMPLIANCE.md` 8.1) | W1 files the issue and blocks Gov rollout on it |
| Q9 | Who is the owner and date for the IL5 lane receipt (`deploy-fiab-il5.yml` has no run)? `cloud-parity.md` requires a dated owner for a boundary that lags | Per-cloud table honesty | Listed as supported-in-code, never exercised, owner "unassigned" |
| Q10 | Product naming and public positioning (Loom Health Data Services vs another name) and whether the HITRUST/FedRAMP evidence pack is a sellable deliverable | Docs and PRD wording | Keep LHDS; evidence pack is internal until decided |

## 3. Risks (with the control)

| # | Risk | Likelihood / impact | Control |
|---|---|---|---|
| R1 | HAPI index bloat makes VA-scale storage cost or restore time unacceptable | M / H | W0 measures bytes/resource; ADR-008 curated set; 20 TB working-set cap; fallback Medplum |
| R2 | dcm4chee operational complexity (WildFly, LDAP) on AKS | M / M | W0 proves restart/backup; Helm owned; fallback path in D2 |
| R3 | Gov image lanes lack Trivy/cosign (#4584) -> unsigned images in a sovereign boundary | H / H | Gate `health-gov-image-gate`; Q8 |
| R4 | PostgreSQL SKU/SSD v2 or Event Hubs Premium absent in Gov Virginia | M / M | W0 closure; design degrades to Premium SSD / Standard TUs with re-sized classes |
| R5 | Repo claims ACA GA in Gov for the admin plane while audit scope shows IL2 only | — / M (not LHDS scope) | Recorded in ADR-009; raised as an issue for the platform owner |
| R6 | Engine CVEs (both engines had critical advisories in 2026) | H / M | Weekly watch job; image rebuilds; blue/green |
| R7 | Lakehouse isolation defect propagates to health data | M / H | Hard gate until GHSA-g7m7 is deployed (Q7) |
| R8 | Synthea 100 M generation infeasible in the pool | M / L | W0 reports the reachable size; load tests scale with what exists |
| R9 | Scope creep toward an EHR | M / M | PRD non-goals; PRP wave ownership |
| R10 | 45-min CI budget broken by engine tests | M / M | Engine suites nightly, not PR CI |
| R11 | Bicep collisions with spark-identity / apim / drain programs | H / M | One bicep PR in flight; LHDS bicep is in its own `modules/health/` tree; only `main.bicep` wiring and params are shared |
| R12 | Operator decisions unanswered stall a wave | M / L | Defaults above; waves proceed on defaults |

## 4. What could not be established in this planning pass

- Azure Government regional GA per service from the products-by-region page
  (client-rendered); closed by W0's Gov Actions run.
- Gov region pairing on Learn; PostgreSQL SSD v2/v5 SKUs in Gov; Event Hubs
  Premium in Gov; Managed HSM Gov audit status; KEDA add-on in Gov; AMPLS in Gov.
- The AHDS SLA percentage at primary source; the VA radiology exam count (page
  404); VistA Imaging PB size (only a 2009 figure); IHS imaging volumes (none).
- dcm4chee and Snowstorm LICENSE texts via the GitHub contents API (404; headers
  and wiki used); LOINC licence page (403; snippet used).
- Any engine's "no calls home" beyond documentation review (W0 adds a packet
  capture / egress-log check on an isolated cluster).
- VA Handbook 6500 and IHS ATO template texts (not fetched; marked UNVERIFIED
  in `SECURITY-AND-COMPLIANCE.md` section 15).
