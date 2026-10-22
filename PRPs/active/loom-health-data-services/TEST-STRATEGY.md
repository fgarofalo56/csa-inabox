# LHDS — Conformance, load, chaos, security and data-integrity test strategy

Governing rule: `.claude/rules/assertion-design.md`. **Every assertion below
names the value that would make it fail.** A suite that cannot go red is
documentation, not coverage, and is labelled as such. Every wave's "done" is a
measured receipt (a command output, a run id, a conformance report), never a
claim. Tool licences are in `research/terminology-conformance-ops-facts.md`
section B; AGPL tools (k6) run only as external load clients and are never
linked into the product.

## 1. Test layers

| Layer | Tool | Runs where | Gate |
|---|---|---|---|
| Unit (TypeScript control plane, PDP policies, converters' Loom glue) | vitest, OPA `opa test` (or the chosen PDP's test runner, ADR-011) | CI (45-min budget) | PR |
| Engine conformance (FHIR) | HL7 FHIR Validator CLI; Inferno test kits (US Core, SMART App Launch, Bulk Data, ONC (g)(10)) self-hosted in the test stamp | Nightly against the Commercial test stamp; per-release against GCC-High via Actions | Wave done |
| Engine conformance (DICOM) | DICOMweb test suites (the engine's own suite per ADR-002; dcm4che tools; pydicom/pynetdicom scripted STOW/QIDO/WADO; DVTk where licence allows) | Nightly / per-release | Wave done |
| Contract tests (Loom BFF routes) | vitest + minted-session probes (existing Loom pattern) | CI | PR |
| Browser E2E (editors, viewer) | Playwright (`pnpm uat` deep-functional spec), screenshots dark/light, narrow-width pass | Pre-merge for UI waves; nightly | `ux-baseline.md` G1 |
| Load | k6 or Locust from Azure Load Testing where available per cloud (`AZURE-GOV-AVAILABILITY.md`), else a Container Apps Job runner; Synthea cohorts; synthetic DICOM generator | W0 spike, W7, W11, then monthly | Capacity receipts |
| Chaos | Chaos Mesh on AKS (Apache-2.0; Azure Chaos Studio has no Gov row per research) | W11, quarterly | DR receipts |
| Security | Trivy + cosign gates (existing), OWASP ZAP baseline against the test stamp, cross-tenant probe suite, log-scrub sentinel test, token/scope fuzzing | CI (fast subset) and nightly | PR / release |
| Data integrity | Golden sets with hashes: FHIR round trip, DICOM pixel hash, conversion fixtures, de-id fixtures, sink row parity | Nightly | Wave done |
| Mutation evidence | For every test that claims to catch a defect: apply the mutation on a sandbox copy, show RED, show the tracked tree untouched (`assertion-design.md` "done" #2) | Per PR adding such a test | PR body |

## 2. FHIR conformance

- **CapabilityStatement truthfulness**: every interaction, search parameter and
  operation the stamp advertises is exercised by a generated test; the
  assertion fails if an advertised parameter returns `OperationOutcome`
  not-supported or ignores the parameter (checked by a query whose result set
  must differ from the unfiltered query: the fixture creates two patients that
  differ only in that parameter).
- **US Core**: Inferno US Core test kit (the version pinned in W2) must pass
  with zero failures for every profile the tenant enables; the receipt is the
  Inferno JSON report. The value that breaks it: any `fail` result.
- **SMART App Launch**: Inferno SMART test kit against the LHDS Authorization
  Server, standalone + EHR launch, v2 scopes, PKCE, refresh; a negative test
  that a `patient/Observation.rs` token cannot read `Condition` (breaks if the
  PDP maps scopes wrongly).
- **Bulk Data**: Inferno Bulk Data test kit for group/patient/system export;
  plus a count-parity assertion: the number of ndjson lines per resource type
  equals the search `_total` for the same group at the export's `transactionTime`
  (breaks on any off-by-N).
- **Validator**: `java -jar validator_cli.jar` over every resource the
  converters emit (HL7 v2 and C-CDA fixtures) against US Core; zero errors; the
  fixture set includes a known-invalid message that must produce an error (the
  positive control that the validator is actually running).
- **Versioning/history**: update a resource N times; `_history` returns N+1
  entries; `vread` of version k returns the kth body hash (breaks if history is
  truncated or reordered).
- **Conditional operations**: concurrent `If-None-Exist` creates with the same
  identifier produce exactly one resource (breaks if two) — run with 50
  parallel clients.
- **Referential integrity policy**: per ADR-003, the engine's configured
  behaviour on dangling references is asserted both ways (a fixture that must
  be rejected and one that must be accepted).

## 3. DICOM conformance

- STOW-RS: single instance, multi-instance study, duplicate instance (must be
  409 or conflict warning per the engine's documented behaviour), invalid
  SOP (must be rejected with the per-instance failure reason), 2 GB study
  streaming (must not buffer in memory: pod RSS stays under the limit — the
  assertion fails if RSS exceeds 2x request size).
- QIDO-RS: every supported query tag; fuzzy matching on PatientName; paging
  `limit`/`offset`; extended query tags after registration (a tag that is not
  registered must be rejected, the positive control).
- WADO-RS: study/series/instance/frames/metadata/rendered; transfer syntax
  negotiation (request `1.2.840.10008.1.2.4.90` JPEG 2000 and assert the
  returned syntax; breaks if transcoding silently returns explicit VR LE);
  byte-identical retrieve of the stored instance (pixel hash equality).
- Change feed: STOW N instances; the feed returns exactly N `Create` events in
  order with sequence numbers (breaks on a gap or duplicate).
- Delete: soft delete then WADO returns 404; audit shows the delete; purge job
  after retention removes the blob (checked with a storage listing).
- IHE: the WIA (Web-based Image Access) and IID (Invoke Image Display) actor
  behaviours are scripted from the IHE RAD TF; participation in an IHE
  Connectathon is an operator decision (D19).
- Viewer: OHIF Playwright suite over the stamp's DICOMweb with a synthetic
  study set (CT, MR, US, DX, MG) — load, scroll, window/level, measurement,
  series switch; the assertion compares a rendered-canvas checksum to a golden
  within tolerance (breaks on a blank canvas, which is the historical failure).

## 4. Test data (synthetic only, never real)

- **Synthea** cohorts (Apache-2.0): 1k / 100k / 1M / 10M / 100M patients,
  generated in the pool (generation throughput is measured in W0 and recorded;
  100M is only feasible as a distributed generation job and the W0 receipt says
  whether it was reached or where it stopped). Fixed seed so cohorts are
  reproducible; the cohort manifest (seed, version, counts) is in the receipt.
- **Synthetic DICOM**: generated with pydicom (valid headers, synthetic pixel
  data with embedded study/series/instance indices so a corrupted retrieve is
  detectable by content), plus public de-identified sets where the licence
  allows (TCIA collections are CC-BY per their pages — each used collection's
  licence URL is recorded in the receipt). No PHI-bearing set is ever used.
- **HL7 v2 / C-CDA fixtures**: the Microsoft FHIR-Converter sample messages
  (MIT) and Synthea-derived C-CDA output; VistA- and RPMS-shaped messages are
  authored from the public interface specs cited in W5 and marked as
  unverified shapes until an agency partner validates them.
- **Golden sets**: every fixture carries a SHA-256; a test that reads a fixture
  asserts the hash first (a changed fixture must fail loudly, not pass
  differently).

## 5. Load and capacity tests

Scenarios (each with the value that breaks it):

| Scenario | Mix | Pass criterion | Breaks when |
|---|---|---|---|
| L1 FHIR steady state | 80 % reads/searches, 15 % writes, 5 % bundles; 1M-patient cohort; per-stamp target QPS from `CAPACITY-MODEL.md` | p95 within section 1 of `OPERATIONS-AND-BCDR.md`; error rate < 0.1 % | Any class exceeds p95 target for 5 consecutive minutes |
| L2 Ingest flood | HL7 v2 ADT/ORU at 10x the per-stamp ingest rate for 30 min | Queue absorbs; lag recovers to target within 15 min after the flood | Message loss (sent != converted + dead-lettered) |
| L3 DICOM ingest | Modality simulators STOW at the per-stamp GB/day rate compressed into 8 h | STOW p95 target; blob throttling (503) count = 0 after backoff | Any instance missing from QIDO after 60 s |
| L4 Viewer fan-out | 200 concurrent viewers scrolling CT series | WADO frames p95; no 5xx | p95 > target or pod OOM |
| L5 Bulk export | Group export of 1M patients while L1 runs | L1 SLOs hold; export throughput reported | L1 degrades > 20 % |
| L6 Search at scale | 10M-patient cohort, 50 search patterns from the real-world list in ADR-008 | p95 per pattern; index size reported | A pattern > 2 s p95 |
| L7 Noisy neighbour | Tenant A at 5x quota, tenant B at normal | B's p95 unchanged (within 10 %) | B degrades > 10 % |
| L8 Scale-out | Add a stamp; route 10 synthetic tenants; rerun L1 on both | Linear: aggregate QPS 2x within 10 % | Sub-linear beyond 10 % |

Receipts: raw k6/Locust summaries, Grafana snapshots, DB metrics, the cohort
manifest, the commit SHA, the cloud (Commercial or GCC-High via Actions run id).
"Quote the population, not the sample": every reported percentile names the
request count it summarises and the window.

## 6. Chaos and DR tests

- Pod kill per tier (API, PDP, converter) during L1: SLO holds (breaks if error
  rate > 1 % for > 30 s).
- PostgreSQL failover (zone-redundant HA) during writes: zero committed writes
  lost (the outbox log is compared with the DB after failover; breaks on any
  committed-but-missing row).
- Blob 503 injection (via a fault proxy): STOW retries with backoff; no
  duplicate instances (breaks if instance count > sent).
- PDP unavailable: all non-break-glass requests fail closed with 503 (breaks if
  any data is returned); break-glass with the cached bundle still works.
- Stamp evacuation drill (`OPERATIONS-AND-BCDR.md` section 6): counts and
  hashes equal.
- Region failover drill (standby stamp): RPO/RTO measured and recorded.

## 7. Security tests

- Cross-tenant probe suite: for every endpoint, tenant A's token with tenant B's
  ids must return 403/404 and zero bytes of B's data (breaks if any body
  contains a B identifier; the fixture plants a unique sentinel in B's data).
- Scope matrix: for each (role, scope, operation) cell, the expected
  permit/deny; generated from the mapping table so a new scope without a row
  fails the build.
- Consent/segmentation: a Part 2-labelled `Condition` must be absent from
  `$everything`, search, `$export` and the sink for a requester without
  consent, present with consent, present under break-glass with a BTG
  `AuditEvent` (three assertions, each breaks on the wrong presence/absence).
- Log-scrub sentinel (`SECURITY-AND-COMPLIANCE.md` section 8.3).
- Audit completeness: every request in a load run has exactly one `AuditEvent`
  (breaks on count mismatch).
- Audit immutability: an attempt to overwrite an hourly audit blob fails with
  the storage immutability error (positive control that the policy is locked).
- Supply chain: an unsigned image is rejected by the admission policy (positive
  control), a signed one admitted.
- ZAP baseline: zero high/medium alerts on the gateway (breaks on any).

## 8. Data-integrity tests

- FHIR round trip: write Synthea bundle, read back every resource, canonical
  JSON hash equality (breaks on any normalisation loss, e.g. decimal precision).
- DICOM pixel hash: STOW then WADO byte equality per instance.
- Conversion: fixture -> FHIR bundle -> validator; plus a semantic assertion per
  fixture (e.g. an ORU with 3 OBX yields 3 `Observation`s with the right LOINC
  codes; breaks on count or code mismatch).
- De-id: Safe Harbor golden set: every one of the 18 identifier classes planted
  in a fixture is absent from the output (18 assertions), and the clinical
  content is preserved (a positive assertion that codes and shifted dates are
  present, so deleting everything cannot pass).
- Sink parity: after a sync window, Delta row count per resource type equals
  the FHIR `_total` at the sync watermark (breaks on any difference).
- Terminology: `$validate-code` for a sampled 1 % of each loaded code system
  against the source file (breaks on any code the source has that the service
  does not, or vice versa).

## 9. Per-wave "done" receipt (what each wave must attach)

| Wave | Receipt |
|---|---|
| W0 | `W0-RECEIPT.md`: engine load numbers per candidate, Gov availability confirmations (Actions run ids), decision table filled |
| W1 | Stamp bicep What-If per cloud; tenant provisioning receipt; cross-tenant probe green on an empty stamp |
| W2 | Inferno US Core + SMART + validator reports; L1 at the 1M cohort; log-scrub sentinel |
| W3 | DICOMweb suite; L3/L4; pixel hash; viewer smoke |
| W4 | Terminology parity sample; `$expand`/`$translate` fixtures |
| W5 | Converter fixture suite; validator; VistA/RPMS spec review sign-off (document, not code) |
| W6 | Bulk Data kit; Safe Harbor golden; sink parity |
| W7 | L6 and L8 receipts; index size and cost measured |
| W8 | Consent/segmentation and audit suites; immutability positive control |
| W9 | Playwright + screenshots + narrow-width + first-open; parity docs zero missing |
| W10 | Device ingest mapping fixtures; Observation parity |
| W11 | Chaos/DR drills; evacuation receipt; SLO measured table replaces the TARGET table |
| W12 | Evidence pack generated and reviewed |

## Related

`OPERATIONS-AND-BCDR.md`, `SECURITY-AND-COMPLIANCE.md`, `CAPACITY-MODEL.md`,
`research/terminology-conformance-ops-facts.md`, `.claude/rules/assertion-design.md`.
