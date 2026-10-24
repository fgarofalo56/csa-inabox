# LHDS — Security architecture, threat model and compliance mapping

> **This document is a design mapping, not a certification.** Nothing here claims
> an ATO, a FedRAMP authorization, a HITRUST certification or HIPAA "compliance"
> for CSA Loom or for LHDS. It states which control each design element is
> *intended* to satisfy and what evidence the platform must be able to produce
> so that a customer's assessor can make that determination. Azure Government's
> own FedRAMP High / DoD IL5 provisional authorizations cover the *Azure
> services*, never a customer solution built on them
> (see `AZURE-GOV-AVAILABILITY.md` note 3).

Reading order: section 1 (principles) is short and binding; 2 (identity), 3
(tenancy), 4 (crypto), 5 (network), 6 (audit), 7 (consent/segmentation),
8 (supply chain, secrets, logs), 9 (de-identification) are the design; 10 is the
STRIDE threat model per component; 11-15 are the control mappings; 16 is the
evidence list an agency authorization package needs from the platform.

## 1. Principles (binding on every wave)

1. **No PHI leaves the stamp's data plane except through a governed egress** —
   `$export` to the tenant's own storage, the de-identified lakehouse sink, or a
   DICOMweb/FHIR response to an authorized caller. Logs, metrics, traces, crash
   dumps and Copilot prompts are *not* governed egresses and must never carry PHI
   (section 8.3).
2. **Tenant isolation is provable, not asserted.** Every store is partitioned by
   `tenantId` at the storage boundary (separate database or schema per tenant on
   a shared stamp; separate storage container per tenant; per-tenant CMK) and
   every data-plane query is tested with a cross-tenant probe that must return
   zero rows. This is the lesson of the private advisory on lakehouse
   storage that was not workspace-isolated: a filter in application code is a
   bug away from a breach; a boundary in the store is not.
3. **Deny by default, authorize at a single PDP.** FHIR scopes, DICOM roles,
   consent directives and security labels are evaluated by one policy decision
   point per stamp; engines never see a request the PDP has not stamped.
4. **Every access is auditable to the person, the patient and the purpose.**
   FHIR `AuditEvent` for every read and write, immutable storage for the audit
   stream, 6-year retention minimum (45 CFR 164.316(b)(2),
   https://www.ecfr.gov/current/title-45/section-164.316).
5. **Keys are the customer's.** Customer-managed keys in Key Vault (Managed HSM
   at IL5 where required), one key per tenant, rotation without downtime, and
   crypto-shredding as the tenant-offboarding primitive.
6. **Nothing calls home.** Engines, viewers and converters run from images in the
   stamp's ACR; outbound egress is deny-by-default through Azure Firewall with an
   allow-list that is part of the bicep and reviewed per change.

## 2. Identity and access

| Concern | Design | Standard / source |
|---|---|---|
| Identity provider | Microsoft Entra ID (Commercial) / Entra ID in Azure Government (`login.microsoftonline.us`); no separate user store. Patients and external apps use Entra External ID / B2B where available per cloud (`AZURE-GOV-AVAILABILITY.md` row "Entra") | https://learn.microsoft.com/en-us/azure/azure-government/documentation-government-plan-identity |
| App-to-FHIR authorization | **SMART App Launch 2.x**: `patient/*.rs`, `user/*.cruds`, `system/*.rs` v2 scopes, `launch/patient`, `fhirUser`, PKCE required, refresh tokens with `offline_access`/`online_access` | https://hl7.org/fhir/smart-app-launch/ (STU 2.2) |
| Backend services | SMART Backend Services (private-key JWT client assertion) for bulk export and integrators; Entra workload identities for Loom-internal services | https://hl7.org/fhir/smart-app-launch/backend-services.html |
| Token issuance | Entra issues the primary token; the **LHDS Authorization Server** (part of the control plane, W1) performs the SMART launch dance, maps Entra groups/app roles to SMART scopes, mints the SMART access token the engines accept, and records the mapping in the audit stream. ADR-010 explains why Entra alone cannot express SMART v2 granular scopes | ADR-010 |
| Roles | Mirror the AHDS role model as Loom roles so operators recognise them: `FHIR Data Reader / Writer / Exporter / Importer / Converter / Contributor`, `DICOM Data Reader / Owner`, `SMART User`, plus LHDS-specific `Health Tenant Admin`, `Break-glass` | `AHDS-MODEL-MAP.md` section 1 |
| Break-glass | A time-boxed (default 4 h), reason-required elevation to `patient/*.read` across consent restrictions, with mandatory `AuditEvent.purposeOfEvent = BTG`, real-time alert to the tenant's security officer, and a forced post-hoc review record. Never silent | HL7 PurposeOfUse `BTG` http://terminology.hl7.org/CodeSystem/v3-ActReason |
| User impersonation | Not supported as a token feature; "act on behalf of" is a scope-limited delegated token with `act` claim preserved in audit | RFC 8693 token exchange, https://www.rfc-editor.org/rfc/rfc8693 |
| Conditional Access | Tenant-side policy; LHDS documents the required policy set (MFA, compliant device for clinician roles, named-location restrictions) in the evidence pack, section 16 | Entra Conditional Access |

## 3. Tenancy isolation (provable)

| Layer | Isolation unit | How it is proved |
|---|---|---|
| Stamp | A set of tenants share a stamp (`ARCHITECTURE.md` section 3); a tenant that requires it gets a dedicated stamp (configuration, not redesign) | Stamp registry entry names the tenants; the tenant-to-stamp router cannot route tenant A to stamp B |
| FHIR store | One PostgreSQL database per tenant on the stamp's server (ADR-003); the engine's connection pool is per tenant; the engine process has no credential to another tenant's database | Cross-tenant probe test: a token for tenant A against every endpoint with tenant B resource ids returns 404/403, never data; database roles enumerated and asserted |
| DICOM store | One metadata schema per tenant; one Blob container per tenant with per-tenant CMK (ADR-004) | Same probe at DICOMweb; a storage-level listing shows no cross-container SAS or role |
| Search / cache | Redis keyspace prefix per tenant, separate database index per tenant; cache keys include `tenantId`, never derived from user input | Fuzz test that a crafted resource id cannot escape the prefix |
| Event stream | Event Hubs: one hub per tenant per event class, consumer groups per subscriber tenant | Role assignments enumerated per hub |
| Lakehouse sink | Separate ADLS container per tenant under the Loom workspace that owns the health tenant (reusing Loom's workspace isolation, with the private lakehouse-isolation advisory fix as a prerequisite — `RISKS-AND-OPEN-DECISIONS.md` Q7) | Loom's existing workspace-isolation tests plus the health-specific probe |
| Keys | One CMK per tenant per purpose (storage, database, backup) | Key Vault access policy enumeration |
| Blast radius | A stamp outage affects only its tenants; a tenant key revocation affects only that tenant | DR drill in `OPERATIONS-AND-BCDR.md` section 6 |

## 4. Encryption

- **At rest**: Azure Storage SSE with CMK + infrastructure (double) encryption;
  PostgreSQL Flexible Server data encryption with CMK; Cosmos (control plane)
  CMK; backups encrypted with the same tenant key.
  Sources: https://learn.microsoft.com/en-us/azure/storage/common/customer-managed-keys-overview ,
  https://learn.microsoft.com/en-us/azure/storage/common/infrastructure-encryption-enable ,
  https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-data-encryption
- **In transit**: TLS 1.2+ everywhere; mTLS between control plane and stamp
  services inside the VNet; DICOM DIMSE (if ever enabled) only over TLS and only
  inside the customer's private network — DIMSE is out of v1 (ADR-002).
- **Key store**: Key Vault Premium (HSM-backed) in Commercial and GCC-High;
  Managed HSM where the customer's IL5 interpretation requires FIPS 140-3 Level 3
  single-tenant HSM — see `AZURE-GOV-AVAILABILITY.md` for the IL5 isolation note
  on Key Vault.
- **Per-tenant keys**: enforced in bicep by the stamp's tenant-provisioning
  module; key rotation is a control-plane job; **crypto-shred** on tenant
  offboarding (destroy the key after the contractual retention export).
- **Field-level**: no application-level encryption of FHIR JSON in v1 (it
  defeats search); the segmentation model (section 7) relies on labels and the
  PDP, not on encryption. Decision D14 in `RISKS-AND-OPEN-DECISIONS.md`.

## 5. Network

- Private endpoints only: no public endpoint on PostgreSQL, Storage, Key Vault,
  Event Hubs, Redis, ACR, AKS API server (private cluster). Public ingress exists
  only at the regional edge (Application Gateway WAF v2 inside the VNet, or Front
  Door Premium with Private Link origins where available per cloud —
  `AZURE-GOV-AVAILABILITY.md` rows "Front Door", "Application Gateway").
- Egress: Azure Firewall with FQDN allow-list (Entra, ARM, Monitor, the stamp's
  ACR, the terminology package feed mirrored into the stamp's storage). The
  allow-list is in bicep; adding an FQDN is a reviewed change (`review: required`).
- DNS: Private DNS zones per service with the Gov suffixes (`*.usgovcloudapi.net`,
  `*.azurecr.us`, `*.vault.usgovcloudapi.net`, `*.postgres.database.usgovcloudapi.net`)
  — the single source is `lib/azure/cloud-endpoints.ts` + the bicep `environment`
  param, never a hard-coded host.
- WAF: OWASP CRS 3.2 with FHIR/DICOMweb-specific exclusions (large multipart
  bodies for STOW-RS, `Prefer: respond-async`), rate-limit rules per tenant key.

## 6. Audit

- Every FHIR interaction produces an `AuditEvent` (R4 profile per IHE BALP where
  the IG is adopted: https://profiles.ihe.net/ITI/BALP/ ) with agent (user, app,
  purpose of use), entity (patient, resource), outcome and the request id; DICOM
  operations produce the DICOM audit message equivalent mapped to `AuditEvent`.
- The audit stream is written to (a) the stamp's audit PostgreSQL schema for
  in-product query, (b) an **immutable** Blob container (time-based retention
  policy, locked, 6 years minimum; https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview),
  and (c) Log Analytics / Sentinel (`LoomAudit_CL`, the existing Loom SIEM path,
  `apps/fiab-console/lib/admin/audit-stream.ts`).
- Tamper evidence: each hourly audit blob carries a SHA-256 chained hash of the
  previous blob written to a separate immutable container; a nightly job
  re-verifies the chain and raises an incident on mismatch (assertion: a
  modified byte in any hour breaks the chain — the test writes one).
- Patient-facing accounting of disclosures: `AuditEvent` search by patient is a
  product surface (W8), satisfying 45 CFR 164.528.

## 7. Consent and sensitive-data segmentation (42 CFR Part 2)

- **Labels**: resources carry `meta.security` labels from the HL7 confidentiality
  and sensitivity vocabularies (https://hl7.org/fhir/security-labels.html ;
  `_confidentiality` `R`/`V`, sensitivity `ETH`, `HIV`, `PSY`, `SUD` ...). A
  **security labeling service** (W8) applies labels at write time from rules
  (code-system membership: e.g. a `Condition` coded in a SUD ValueSet gets `SUD`)
  and from source system tags (a Part 2 program's HL7 v2 feed is labeled wholesale).
- **Consent**: FHIR `Consent` resources (https://hl7.org/fhir/consent.html)
  record the patient's Part 2 consent (purpose, recipient, period, redisclosure
  prohibition). The 2024 Part 2 final rule aligns Part 2 consent with HIPAA
  treatment/payment/operations uses once a single consent is given, and keeps the
  redisclosure notice requirement
  (https://www.hhs.gov/hipaa/for-professionals/regulatory-initiatives/fact-sheet-42-cfr-part-2-final-rule/index.html).
- **Enforcement point**: the stamp PDP evaluates (requester role, purpose of use,
  patient consent, resource labels, break-glass) and returns permit / deny /
  **redact** (strip labeled resources from a Bundle, `$everything`, `$export`,
  and from the lakehouse sink). The PDP is an OPA-style policy engine with
  policies in the repo and a conformance test suite (W8); it is aligned with
  Loom's existing access-policy model (`lib/azure/access-policy-client.ts`) but is
  its own service because latency sits on the read path. ADR-011.
- **Redisclosure**: every response containing Part 2 data carries the required
  notice as a `Bundle.meta.security` label and an HTTP header the viewer renders;
  `$export` output files for Part 2 data are written to a separate, labeled
  destination.
- **DICOM**: studies inherit the patient's and the ordering context's labels
  (stored as extended query tags); QIDO results are filtered by the same PDP.

## 8. Supply chain, secrets, logs

### 8.1 Supply chain
Images are built by the existing ACR task pool, scanned by Trivy (CRITICAL
gate) and signed with cosign before a stamp may pull them (the Commercial lane
has this; the Gov image lanes do not — issue #4584 — and LHDS Gov images must
not ship until the Gov lane has the same gate: `RISKS-AND-OPEN-DECISIONS.md`
R3). SBOMs (SPDX) are attached as OCI artifacts. Upstream engine images are
rebuilt from source in the pool, never pulled from Docker Hub at deploy time
(`docs/fiab/deployment/upstream-image-mirror.md` pattern).

### 8.2 Secrets
No secret in code, bicep params, workflow logs or the conversation. Engine
database access uses Entra authentication (PostgreSQL Entra auth, managed
identity) wherever the engine supports it; where an engine needs a password
(ADR-001/002 record which), it is generated by the stamp bicep, stored in Key
Vault, injected by CSI secret store, rotated by a control-plane job.

### 8.3 PHI in logs — prevention and the log-scrub test
- Engines are configured to log request ids, not bodies; access logs record
  resource type and id (an id is PHI-adjacent, so logs are themselves in the
  audit retention class and are not exported to any shared workspace).
- A **log scrubber** sidecar/pipeline applies redaction rules (names, MRNs, DOB
  patterns, DICOM PatientName/PatientID tags, URL query strings containing
  `identifier=`) before any line leaves the stamp.
- **The log-scrub test** (W2 onward, run in CI against every engine image): load
  a Synthea patient with a sentinel surname `ZZLOGPROBE<random>`; perform every
  operation class; grep every log sink for the sentinel; the assertion fails on
  the first hit. The value that breaks it is the sentinel appearing in any sink.
- Copilot: the read-only health tools return counts, ids and codes, never
  narrative text; prompts are logged with the same scrubber.

## 9. De-identification service (model: AHDS de-identification)
Operations `tag` (find PHI), `redact`, `surrogate` (consistent replacement),
date-shift (per-patient offset, stable), hash-with-salt for identifiers, and
DICOM tag de-identification per DICOM PS3.15 Annex E profiles
(https://dicom.nema.org/medical/dicom/current/output/chtml/part15/chapter_E.html)
with the Basic Profile plus the Retain Longitudinal Temporal Information with
Modified Dates option as the default; pixel-burned-in text detection is a
flagged, not-guaranteed, step (OCR-based) — disclosed as such. HIPAA Safe Harbor
18-identifier coverage is tested against a golden set; Expert Determination is a
**hook** (an exportable report of residual quasi-identifiers), never a claim.
Source: https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html.
Candidate OSS: `microsoft/Tools-for-Health-Data-Anonymization` (FHIR + DICOM),
Microsoft Presidio (text) — ADR-015, licences per `research/oss-engine-evaluation.md`.

## 10. STRIDE threat model per component

| Component | S (spoof) | T (tamper) | R (repudiate) | I (info disclosure) | D (DoS) | E (elevate) |
|---|---|---|---|---|---|---|
| Edge (WAF / Front Door / APIM) | Token theft → short-lived tokens, PKCE, DPoP later (D15) | Request smuggling → WAF CRS, strict HTTP parsing in APIM | Missing access log → edge logs with request id joined to AuditEvent | Error pages leaking stack → generic errors (deploy-integrity R7 still requires truthful messages: truthful ≠ verbose) | Volumetric → Front Door/App Gateway DDoS, per-tenant rate limits, STOW body caps | WAF bypass → private origins, no direct stamp ingress |
| Authorization server / PDP | Forged client assertion → JWKS pinning, `jti` replay cache | Policy tamper → policies in git, signed bundle, hash checked at load | Decision not logged → every decision writes an AuditEvent with policy version | Scope over-grant → scope mapping tests, deny-by-default | PDP latency → cached decisions with short TTL keyed by (subject, patient, labels-hash) | Group-claim injection → groups resolved server-side via Graph, never trusted from the client |
| FHIR engine | Engine admin endpoints exposed → removed/disabled, network-policy isolated | Direct DB write bypassing engine → DB roles: only the engine role writes; audit triggers | History deleted → history immutable, `$purge` is an audited admin op only | Cross-tenant query → per-tenant DB (section 3) | `_include` / `_revinclude` bombs, `$everything` on huge patients → paging caps, async for large ops, per-tenant quotas | Search-parameter injection → engine's parameterised SQL; probe tests |
| DICOM engine | Spoofed STOW source → system-token per modality gateway; no DIMSE in v1 | Pixel data altered → blob versioning + content hash in metadata; immutable option per tenant | Study deletion unlogged → deletes are soft, audited, retained 30 days | WADO frame fetch across tenants → per-tenant container; SAS never issued to clients (streams via the engine) | 10 GB multipart STOW → request size cap, streaming parser, body-size-based rate limit | Extended query tag abuse → tag allow-list per tenant |
| Event / outbox | Replayed events → idempotency key per event | Event order tamper → sequence numbers in the outbox table | Lost event claims → outbox row retained until consumer ack | PHI in event payload → events carry ids only; consumers fetch | Consumer lag → KEDA scaling on lag, dead-letter with alert | Consumer group hijack → Entra RBAC per consumer group |
| Converter (HL7 v2 / C-CDA) | Spoofed MLLP sender → MLLP only over TLS inside the customer network; API path requires system token | Template tamper → templates versioned, signed, tested | Conversion not traceable → `Provenance` resource per converted bundle with template version | Source message retained in logs → scrubber + raw message store with the same retention class as PHI | Message floods → queue-backed, backpressure | Template code execution → Liquid sandboxed, no custom filters that touch the filesystem |
| De-id / export jobs | Job submitted by wrong tenant → job scoped to the caller's tenant | Output substituted → output written with content hash manifest | Export unaccounted → `AuditEvent` per export with file list | Re-identification via quasi-identifiers → Expert Determination hook, k-anonymity report | Giant exports → chunked, resumable, quota | Job identity reused → per-job managed identity federated credential, short-lived |
| Lakehouse sink | Fake sink writer → sink identity is the stamp's UAMI only | Delta table rewritten → Delta log + Loom's existing lakehouse ACLs | Rows without lineage → `_provenance` columns (resource id, version, stamp, ts) | Labeled (Part 2) rows in the lake → PDP redaction before sink; a tenant flag to exclude labeled data entirely | Backfill storms → rate-limited backfill job | Workspace crossing → the private lakehouse-isolation advisory fix prerequisite |
| Viewer (OHIF) | Token in URL → tokens in header via the Loom BFF, never in query | Tampered viewer bundle → built in the pool, SRI hashes | Viewing not logged → WADO fetch is the audited event | Cached frames on disk → viewer served with `Cache-Control: no-store` for PHI responses | Large series → progressive loading, HTJ2K later (D16) | Viewer config injection → config from the BFF only |
| Control plane (Loom console + health CP) | Admin session theft → existing Loom session hardening | Stamp registry tamper → Cosmos with etag + audit | Routing changes unlogged → every registry change audited | Registry leaks tenant names → registry access is tenant-admin scoped | Registry down → router caches last-known-good map | Loom admin → health admin → separate `Health Tenant Admin` capability, not inherited from Loom Admin by default (D12) |

## 11. HIPAA Security Rule mapping (45 CFR 164.308-164.316)

| Standard | Implementation specification | LHDS design element | Evidence the platform produces |
|---|---|---|---|
| 164.308(a)(1) Security management | Risk analysis, sanctions, activity review | This document's threat model; audit review surface (W8); Defender for Cloud secure score | Threat model (this file), monthly audit-review report export |
| 164.308(a)(3) Workforce security | Authorization/supervision, clearance, termination | Entra lifecycle; Loom role assignment audit; break-glass review | Role-assignment export, break-glass review log |
| 164.308(a)(4) Information access management | Access authorization, establishment, modification | PDP policies; SMART scopes; tenant-admin role model | Policy bundle version, scope-mapping table, access-change audit |
| 164.308(a)(5) Security awareness | Log-in monitoring, password mgmt | Entra sign-in logs + Conditional Access; no local passwords | Sign-in log export (tenant), CA policy evidence (tenant) |
| 164.308(a)(6) Security incident procedures | Response and reporting | Sentinel analytics rules shipped with LHDS; incident runbook (`OPERATIONS-AND-BCDR.md` section 8) | Alert rule inventory, incident records |
| 164.308(a)(7) Contingency plan | Backup, DR, emergency mode, testing | `OPERATIONS-AND-BCDR.md` sections 4-6 | Backup inventory, DR drill receipts |
| 164.308(a)(8) Evaluation | Periodic technical evaluation | Conformance and security test suites per wave; quarterly teardown (`no-vaporware.md`) | Test receipts |
| 164.310 Physical safeguards | Facility, workstation, device | Azure data-centre controls (inherited — Azure's SOC/FedRAMP reports, customer-shared via Service Trust Portal) | Inherited; cite STP report id in the evidence pack |
| 164.312(a)(1) Access control | Unique user id, emergency access, auto logoff, encryption | Entra ids; break-glass; session timeout in the Loom console; CMK | Section 2, 4 evidence |
| 164.312(b) Audit controls | Record and examine activity | Section 6 | Immutable audit chain verification report |
| 164.312(c) Integrity | Protect from improper alteration | Resource versioning, blob versioning, hash chain | Integrity test receipts |
| 164.312(d) Person or entity authentication | Verify identity | Entra + SMART; mTLS for services | Token validation tests |
| 164.312(e) Transmission security | Integrity + encryption in transit | TLS 1.2+, private endpoints | TLS policy scan output |
| 164.316 Policies, documentation, retention | 6-year retention | Immutable audit retention policy | Retention policy export |

Source: https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C

## 12. NIST SP 800-53 Rev. 5 — High baseline families (FedRAMP High)

Family-level mapping; the per-control matrix (about 400 rows at High) is a W12
deliverable generated from this table plus the Azure Government customer
responsibility matrix (CRM) that Microsoft publishes for FedRAMP High
(available to customers through the Service Trust Portal — the platform cites
it, it does not reproduce it).

| Family | Inherited from Azure Gov (per CRM) | LHDS responsibility (design element) |
|---|---|---|
| AC Access Control | Physical, hypervisor | AC-2/3/6: Entra + PDP + role model; AC-4 info flow: labels/PDP/egress firewall; AC-17 remote access: private endpoints |
| AU Audit and Accountability | Platform logs | AU-2/3/6/9/11/12: section 6 (content, review surface, immutability, 6-year retention) |
| CA Assessment, Authorization | Azure P-ATO | CA-7 continuous monitoring: Defender for Cloud + Sentinel + deploy-staleness checks; CA-8 pen test: customer activity, platform provides the test plan |
| CM Configuration Management | Host images | CM-2/3/6/7/8: bicep as baseline, PR review gates, image SBOM inventory, allow-listed egress |
| CP Contingency Planning | Region/zone resilience | CP-6/7/9/10: `OPERATIONS-AND-BCDR.md` |
| IA Identification and Authentication | Entra service | IA-2 MFA (tenant CA policy), IA-5 authenticators (no passwords in LHDS), IA-8 non-org users (patient apps via External ID) |
| IR Incident Response | Azure IR | IR-4/5/6: Sentinel rules, runbook, breach-notification data (which patients, which records: the audit store answers it) |
| MP Media Protection | Datacentre media | MP-6 sanitization: crypto-shred on offboarding |
| RA Risk Assessment | — | RA-3/5: threat model, Defender vulnerability scanning, Trivy |
| SA System and Services Acquisition | — | SA-10/11: supply chain (8.1), SA-15 development process (the repo's rules) |
| SC System and Communications Protection | Network fabric | SC-7 boundary: firewall/WAF/private link; SC-8 transit; SC-12/13/28 crypto/CMK; SC-39 process isolation: per-tenant DB/containers |
| SI System and Information Integrity | — | SI-3/4/7: Defender for Containers, integrity hash chain, alerting; SI-10 input validation: FHIR validation, DICOM parser hardening |
| SR Supply Chain Risk | — | SR-3/4/11: SBOM, signed images, provenance |

Source: https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final ; FedRAMP High baseline https://www.fedramp.gov/

## 13. 42 CFR Part 2 mapping

| Requirement (2024 final rule) | Design element |
|---|---|
| Single consent for TPO uses once given; consent revocable | `Consent` resource lifecycle; PDP evaluates period and revocation in real time |
| Redisclosure prohibition notice accompanies disclosures | Response label + header + export manifest (section 7) |
| Part 2 records segregated / identifiable as such | `SUD` sensitivity label at write; wholesale labeling for Part 2 program sources |
| Accounting of disclosures to the patient | `AuditEvent` by patient (section 6) |
| Breach notification aligned with HIPAA | Same incident data path as section 12 IR |
| Use in legal proceedings restricted | PDP purpose-of-use `LEGAL`? denied by default; requires explicit consent record |

Source: https://www.ecfr.gov/current/title-42/chapter-I/subchapter-A/part-2 and the HHS fact sheet linked in section 7.

## 14. HITRUST CSF (v11) — domains

HITRUST certification is a customer-driven assessment; the platform maps its
controls to the 19 CSF domains so an assessor can inherit evidence. Domain
list source: https://hitrustalliance.net/ (framework overview). The mapping
rows are identical in substance to sections 11-12 (HITRUST harmonises HIPAA and
NIST); W12 produces the domain-indexed view. **UNVERIFIED**: exact CSF v11
control ids require the licensed CSF text, which this repo does not hold.

## 15. VA Handbook 6500 / IHS authorization evidence

VA Handbook 6500 (Risk Management Framework for VA Information Systems) requires
an RMF package built on NIST 800-53; the VA-specific additions the platform must
be ready to evidence (from public VA guidance; the handbook text itself is
**UNVERIFIED** here — obtain the current edition from https://www.va.gov/vapubs/ ):

- System Security Plan inputs: boundary diagram (stamp + control plane), data
  flow diagram with PHI paths (this file + `ARCHITECTURE.md`), ports/protocols
  table (bicep-generated).
- Continuous monitoring feeds: Defender, Sentinel, vulnerability scan exports.
- Contingency plan and test results: `OPERATIONS-AND-BCDR.md` drills.
- Interconnection security agreements: VistA / RPMS adapter specs (W5) describe
  each interface's direction, protocol, encryption and authentication.
- Privacy Impact Assessment inputs: data inventory per FHIR resource type and
  DICOM tag class; de-identification capabilities.
- IHS follows HHS/OCIO policy and NIST 800-53 for its ATO; the same package
  applies with HHS-specific templates (**UNVERIFIED** which templates; the IHS
  Division of Information Security publishes them to contractors).

## 16. Evidence the platform must be able to produce (W12 deliverable)

1. Role and scope inventory (export): every Entra role → SMART scope mapping and
   every PDP policy with version and test results.
2. Tenant isolation receipt: the cross-tenant probe output per stamp per release.
3. Encryption receipt: CMK inventory per tenant (key id, rotation date), TLS scan.
4. Audit receipt: hash-chain verification report, retention policy state, sample
   `AuditEvent` per operation class.
5. Network receipt: effective NSG/firewall rules, private endpoint inventory,
   public-exposure scan (zero public data-plane endpoints).
6. Supply chain receipt: SBOM + signature verification for every image in the
   stamp; Trivy results.
7. BCDR receipt: last restore drill (Postgres PITR + Blob), last stamp evacuation
   drill, RPO/RTO measured.
8. Conformance receipt: Inferno / validator / DICOMweb suite results
   (`TEST-STRATEGY.md`).
9. Log-scrub receipt: the sentinel test output per release.
10. Per-cloud: each receipt labelled Commercial or GCC-High with the GitHub
    Actions run id (Gov receipts never from a workstation).

## Related

`ARCHITECTURE.md`, `adr/ADR-010-identity-smart.md`, `adr/ADR-011-consent-pdp.md`,
`adr/ADR-012-encryption-keys.md`, `OPERATIONS-AND-BCDR.md`, `TEST-STRATEGY.md`,
`RISKS-AND-OPEN-DECISIONS.md` (D12-D16, Q7), `research/compliance-and-standards.md`.
