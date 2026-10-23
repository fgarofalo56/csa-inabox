# LHDS W0 receipt — measurement and decision spike

**Status: PARTIAL (no-cost pass, 2026-10-22).** The pass-bar measurements need
the class-S sandbox. Its budget (Q2) and subscription are not approved yet, so
every sandbox cell below reads "not measured". **No ADR status line moves on this
receipt.** W0-7, the decision pass, has not started.

- Plan: `W00-measurement-spike.md`. Branch `feat/lhds-w0-no-cost`, stacked on
  the PRD/PRP docs PR #5091. Integration facts were measured at `origin/main`
  `b192f05ea347086c772af1cb876d94fc845083c8`.
- Operator decision, 2026-10-22: run the no-cost items first. Nothing in Azure
  was created, no `az` command ran against any subscription, and no workflow was
  dispatched. The sandbox subscription will be a separate subscription from the
  Loom estate, not yet named.
- LOCAL SMOKE numbers come from laptop Docker on cohorts of 30–45 patients. They
  show that the scripts run end to end, and they are **not pass-bar evidence**.
  Each section labels them that way.

## Item status

| Item | State | Evidence |
|---|---|---|
| W0-1 FHIR engines | Scripts written and smoke-run locally (HAPI 8.12.0, Medplum 5.2.7). Sandbox not measured. | Sections 1-2 |
| W0-2 DICOM engine | Scripts written and smoke-run locally (dcm4chee-arc-light 5.35.2, filesystem storage). Sandbox and Blob not measured. | Section 3 |
| W0-3 Gov closure | **Done for usgovvirginia.** #5092 merged and dispatched; run 39887825372 succeeded (11 steps, 15/15 probes rc 0). Arizona and Texas PostgreSQL not probed. | Section 4 |
| W0-4 Egress | Scripts written. The report's exit codes were tested on fixtures. Capture not executed, because there is no cluster. | Section 5 |
| W0-5 Synthea | Scripts written and smoke-run locally. Pool throughput and the 48 h cohort size not measured. | Section 6 |
| W0-6 Loom integration | **Done.** All 7 facts measured at `b192f05ea`, each with `file:line`. | Section 7 |
| W0-7 Decision | Not started. Needs W0-1..W0-5 sandbox numbers. | Section 8 |

## Findings so far (all subject to the sandbox run)

1. **The IL5 control-plane premise was wrong (measured, already corrected).**
   `containerPlatform` is `containerApps` in all 7 param files, including
   `il5.bicepparam:121`. The PRP set said IL5 AKS came "via the existing switch".
   Corrected in #5091 by `0b9b106de`.
   - `il5.bicepparam:121` justifies Container Apps at IL5 as "ACA GA in USGov
     regions". Regional GA is not IL5 audit scope, and this PRP set's own Gov
     table marks Container Apps "no" at IL5.
   - That is a pre-existing Loom IL5 question outside LHDS. It is not filed yet.
2. **dcm4chee on Azure Blob is unverified.** dcm4che documents jclouds object
   storage for S3 only. A Blob descriptor would mean shared-key or SAS auth, not
   managed identity. This is ADR-002's first sandbox test; gaps G1-G3 are in
   `dicom-engine-deploy.sh`.
3. **Bytes per resource came out above the 6 KB bar locally.** HAPI was about 9.9 KB
   and Medplum about 7.9 KB, against ADR-001's 6 KB reversal bar and the 4.5 KB
   capacity assumption.
   - The cohort was tiny and ran on default config, so this does not establish
     anything.
   - The benchmark ADR-001 cites works out to about 11 KB per resource for HAPI.
     The 4.5 KB assumption is the number most at risk.
4. **Medplum needs non-default config for bulk loads.** It rejected large bundles
   at its 1 MB default size limit, and its default rate limit throttled the load
   with per-entry 429s inside an HTTP 200 response.
   - A failed transaction looks partially committed on Medplum, so its atomicity
     is unproven. That needs a targeted W2 test.
5. **HAPI's `ImagingStudy?patient=` p95 was about 10x its other query patterns
   locally.** It reproduced across two runs, and the cause is not diagnosed.
6. **The load drivers need Linux pods in the sandbox.** The Git Bash DICOM
   driver reached about 14 of 60 requested senders in flight.
7. **A fixed Synthea seed is not byte-reproducible.** One CarePlan differed
   between two runs, so the manifest hash, not the seed, identifies a cohort.
8. **PostgreSQL is not available to the Gov subscription in usgovvirginia (Q1),
   measured.** The API offers zero SKUs, `OfferRestricted` is on, and the reason
   is "open a support request". Every LHDS engine sits on PostgreSQL, so the Gov
   stamp is blocked until a support request lifts the restriction or another
   Gov region proves usable. Arizona and Texas are not probed yet (section 4.1).
9. **Azure Load Testing does not exist in Gov.** The resource type is absent,
   so Gov load tests must use in-cluster drivers.
10. **GHSA-g7m7 (Q7) is only partly answered.** Commercial is established; Gov is
   not. Details are in section 7.6, deliberately neutral.


## 1. FHIR engine comparison (W0-1: HAPI FHIR JPA vs Medplum)

Scripts: `scripts/measure/health/fhir-engine-{lib,load,bytes,query,export,report}.sh`, authored on the
`feat/lhds-w0-no-cost` worktree stacked on `7da37991c` (scripts untracked at measurement time; the
orchestrator's commit SHA is the ref for the script text).

### 1.1 Sandbox measurement (the pass-bar evidence): NOT MEASURED

| Metric (unit) | HAPI FHIR JPA | Medplum | ADR-001 bar / assumption |
|---|---|---|---|
| Disk bytes per stored resource, Synthea 100 k cohort, 1 M-patient projection (bytes/resource) | not measured: sandbox not provisioned (operator decision 2026-10-22) | not measured: sandbox not provisioned (operator decision 2026-10-22) | reversal bar > 6 KB; assumption 4.5 KB |
| Import throughput, 100 k cohort (resources/s) | not measured: sandbox not provisioned (operator decision 2026-10-22) | not measured: sandbox not provisioned (operator decision 2026-10-22) | none stated |
| L1 mix req/s and p95 at 1 M patients, class-M database | not measured: sandbox not provisioned (operator decision 2026-10-22) | not measured: sandbox not provisioned (operator decision 2026-10-22) | search p95 > 1 s reverses |
| ADR-008 pattern p95 at 1 M patients | not measured: sandbox not provisioned (operator decision 2026-10-22) | not measured: sandbox not provisioned (operator decision 2026-10-22) | search p95 > 1 s reverses |
| `$export` res/s, single path | not measured: sandbox not provisioned (operator decision 2026-10-22) | not measured: sandbox not provisioned (operator decision 2026-10-22) | baseline for the 23 k res/s target |

Consequence: ADR-001's W0 pass bar is **not evaluated**. Nothing below can move the ADR status line.

### 1.2 LOCAL SMOKE (NOT pass-bar evidence)

**These numbers are NOT pass-bar evidence.** They come from a laptop Docker Desktop (8 CPUs, 37.4 GiB
shared with ~20 unrelated containers, Windows host, loopback port-forwards), a tiny cohort, and a single
run per cell. They prove only that the scripts execute end to end against both engines and produce
non-empty, distinct cells. Do not compare them to the 6 KB / 1 s bars.

What was run (2026-10-22 evening local time):
- Cohort: Synthea `master-branch-latest` jar (sha256 `20098ec70c24c715ea874b19140983634711cc4986196105b5b0a9ca72a4b644`),
  `-s 42 -p 30` in `eclipse-temurin:17-jre`. Output: 47 transaction-bundle files (2 shared
  hospital/practitioner + 45 patient bundles; Synthea adds replacement patients for the deceased), 303 MB.
  The single failing bundle (below) is why 102,507 resources, not the file total, were loaded.
- HAPI: `hapiproject/hapi@sha256:0ff86aac...a04e` (server 8.12.0, FHIR 4.0.1) + `postgres:16` (16.15,
  `postgres@sha256:9e2cf628...`), default config except `HAPI_FHIR_BULK_EXPORT_ENABLED=true` and
  `HAPI_FHIR_ALLOW_EXTERNAL_REFERENCES=true`. No JVM or PostgreSQL tuning.
- Medplum: `medplum/medplum-server@sha256:7ccb89e5...74d` (5.2.7) + `postgres:16` + `redis:7`. **Non-default
  config was required**, which is itself an observation: `MEDPLUM_MAX_JSON_SIZE=100mb` (default 1 mb returned
  HTTP 413 on 41 of 47 bundles) and rate limiting disabled (the default FHIR quota of 50,000 returned
  per-entry 429s inside an HTTP 200 transaction response; the first Medplum load "succeeded" at 5,123 res/s
  while only 4,640 resources were stored; the loader's SQL cross-check caught it and the loader now counts
  per-entry statuses). Medplum client auth used a throwaway local user/project and bearer token (not recorded).
- Both engines loaded with 2 parallel POST threads, in the same order (shared bundles first).
- Raw files: `temp/lhds-w0/l1/results/{hapi,medplum}.tsv` (not committed).

Receipt table (`fhir-engine-report.sh`, exit 0; context `local-smoke` for both engines):

| Metric | Counts / measured where | HAPI | Medplum |
|---|---|---|---|
| resources_posted | resources acknowledged 2xx per-entry, 46 of 47 bundles | 102,507 | 102,507 |
| bytes_per_resource (net) | (`pg_total_relation_size` of all tables in schema `public` after load minus same before load) / live resources (HAPI: `hfj_resource` not deleted; Medplum: per-type tables, not deleted, excluding the built-in R4 project's ~4.3 k seeded definitions) | 9,903.3 B | 7,854.3 B |
| bytes_per_resource (gross, includes empty-schema floor) | total bytes / live resources | 9,922.8 B | 8,817.7 B |
| load_res_s | resources_posted / wall seconds, 2 threads, includes HTTP + JSON parse in a Python client | 660.74 res/s (155.1 s) | 148.70 res/s (689.4 s) |
| mix_req_s | L1 mix (section 2), 60 s, 8 threads, Python client | 128.3 req/s | 327.5 req/s |
| mix_p95_ms | client-observed p95 over the whole mix | 90.7 ms | 47.6 ms |
| export_res_s | system `$export` kickoff to last ndjson file downloaded, single path | 3,848.68 res/s (103,477 res, 26.9 s) | 15,938.24 res/s (103,971 res, 6.5 s) |

Run-to-run variance is large and is the main reason these are not evidence. HAPI was measured twice
for query and export on the same loaded database: mix 184.6 req/s / p95 115.5 ms (11,137 requests, 0
errors) then 128.3 req/s / p95 90.7 ms (8,613 requests, 1 error, cause not diagnosed); export 2,832.5
res/s (103,060 res) then 3,848.7 res/s (103,477 res). The table shows the second run. Medplum was run
once.

Observations worth carrying forward (each is a local-smoke observation, to be confirmed or refuted by the
sandbox run):
1. Both engines stored more than 6 KB per resource on this cohort (HAPI 9.9 KB, Medplum 7.9 KB net). If
   the ratio held at scale it would exceed ADR-001's 6 KB reversal bar and CAPACITY-MODEL 1.3's 4.5 KB
   assumption. It is not established that it holds: the cohort is 45 patients / about 1 GB, HAPI ran with
   every standard search parameter indexed, and Postgres had default settings. For reference the benchmark
   ADR-001 cites (~22.6 GB per ~2 M resources) works out to ~11 KB per resource for HAPI, which is
   closer to this local figure than to the 4.5 KB assumption.
2. This cohort is heavier than the CAPACITY-MODEL figure (about 2,280 resources per patient bundle vs
   1,123 cited), so per-patient storage is not comparable either.
3. One Synthea bundle (`Lindsay928_Zieme486_...json`) fails on both engines: it carries a conditional
   reference `Location?identifier=...|null`. HAPI rejected it with HTTP 404 (HAPI-1091) and the stored
   count equals resources_posted exactly (102,507), consistent with nothing being committed. Medplum
   returned HTTP 200 with 486 of 496 entries acknowledged; Medplum's live count (103,061) is 554 above
   resources_posted, consistent with the failed transaction committing its 486 acknowledged entries
   (the remaining ~68 are not attributed; not verified). Atomicity of a failed transaction on Medplum is
   unproven by this run and worth a targeted W2 test.
4. The loader's cross-check (SQL stored count >= 90 % of acknowledged) fired once during development
   (4,640 vs 103,003) and the report script's controls were exercised (below).

Control runs (assertion-design). Mutations were applied to sandbox copies of the result files under
`temp/lhds-w0/l1/report-mutation/`; the tracked tree was not touched.

| Mutation | Value that should break it | Result |
|---|---|---|
| medplum.tsv = byte copy of hapi.tsv | identical core metrics | exit 2, "bytes_per_resource has identical values" |
| medplum `export_res_s` line deleted | missing cell | exit 1, "EMPTY CELL: engine=medplum metric=export_res_s" |
| medplum `p95_P7_imagingstudy` blanked | empty value | exit 1, names the cell |
| medplum `load_res_s` set equal to HAPI's, everything else real | one identical core cell | exit 2 |
| unmutated results | none | exit 0 |

Script defects found and fixed during the smoke run (so the scripts at hand are the fixed versions):
Windows Python emitted CRLF into the last TSV field so cells silently failed to match (fixed with
`lib_py`); `set -e` did not propagate out of command substitution so a failed per-table count was
swallowed (fixed with `inherit_errexit` plus a single atomic SQL count); an HTTP-2xx transaction with
failed entries was counted as loaded (fixed). The HAPI load ran on the version of `fhir-engine-load.sh`
before the per-entry check; its SQL cross-check (stored 102,507 = posted 102,507) corroborates it, but it
was not re-run on the final script (re-loading would duplicate data).

Not executed locally: 100 k cohort; 1 M-patient projection; class-M database; Inferno US Core run;
CVE-process criterion of the ADR-001 bar; k6 (a documented Python-stdlib timer is used instead; its
req/s is a lower bound on the engine).

## 2. Query and export patterns (W0-1, ADR-008 patterns and the L1 mix)

Script: `scripts/measure/health/fhir-engine-query.sh` (patterns and mix), `fhir-engine-export.sh` (`$export`).

### 2.1 Definitions

Patterns are the ranked list in `CAPACITY-MODEL.md` section 4 (which ADR-008 adopts as its curated set),
with parameters drawn at random (fixed seed 42, same draw order for both engines) from the loaded data:

| ID | Request |
|---|---|
| P1 | `Patient?identifier=<value>` |
| P2 | `Observation?patient=&category=vital-signs&date=ge2000-01-01&_sort=-date&_count=100` |
| P3 | `Condition?patient=`, `MedicationRequest?patient=`, `AllergyIntolerance?patient=` (three separate rows) |
| P4 | `Encounter?patient=&date=ge2000-01-01`; `Encounter?location=&date=ge2000-01-01` |
| P5 | `DocumentReference?patient=&date=ge2000-01-01&type=<sampled system|code>` |
| P6 | `Patient?name=<family>&birthdate=<date>` |
| P7 | `ImagingStudy?patient=` |
| P9 | `Observation?_lastUpdated=ge2000-01-01&_count=100` |

Not measured: P8 (`Group/{id}/$export`: the smoke cohort has no Group), P10 (full-text, out of v1 per
D20), and ADR-008 behaviours that are not requests (cursor pagination caps, `_include` depth caps,
`$everything` async switch).

**L1 mix** (defined here because CAPACITY-MODEL s11 names the mix without a weight table): for 60 s, 8
threads, each request is a write with probability 5 % (an `Observation` create for a sampled patient;
CAPACITY-MODEL 1.3 assumes 20 reads per write, 4.8 %), otherwise a read drawn by weight from:
P1 30, P2 20, P3 (three rows) 5 each, P4-patient 8, P4-location 2, P5 8, P6 6, P7 3, P9 2. The weights
are the CAPACITY-MODEL s4 frequency ranking converted to numbers by this script; they are an assumption,
not a measurement (W7 replaces them).

Per-pattern p95 is measured separately: 200 sequential requests per pattern at concurrency 1 (latency,
not queueing), client-observed (includes loopback and Docker port-forward hops).

### 2.2 Sandbox measurement: NOT MEASURED

| Cell | Result |
|---|---|
| p95 per pattern at 1 M patients, class-M database, HAPI | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| p95 per pattern at 1 M patients, class-M database, Medplum | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| L1 mix req/s and p95 per engine, single pod | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| `$export` res/s per engine at 100 k-patient cohort | not measured: sandbox not provisioned (operator decision 2026-10-22) |

### 2.3 LOCAL SMOKE (NOT pass-bar evidence)

**These numbers are NOT pass-bar evidence.** Same environment, cohort and caveats as section 1.2
(laptop Docker, 45 patients / ~102 k resources, one run per cell for Medplum, two for HAPI, Python
client). Do not compare them to the ADR-001 "search p95 > 1 s at 1 M patients" bar: a 1 M-patient
database is about 10,000x this one in resource count, and no query here approaches the 1 s bar for the
reason that the table is small.

p95 per pattern, ms, 200 requests each, concurrency 1, context `local-smoke`:

| Pattern | HAPI p95 | Medplum p95 | Mean entries per page (HAPI / Medplum) |
|---|---|---|---|
| P1 Patient?identifier | 35.0 | 33.3 | 1.0 / 1.0 |
| P2 Observation vitals sorted | 90.7 | 35.2 | 69.5 / 68.9 |
| P3 Condition | 43.5 | 30.6 | 18.4 / 18.4 |
| P3 MedicationRequest | 42.0 | 36.6 | 13.4 / 14.0 |
| P3 AllergyIntolerance | 32.0 | 31.6 | 1.0 / 1.0 |
| P4 Encounter patient+date | 43.8 | 32.1 | 15.9 / 15.9 |
| P4 Encounter location+date | 40.7 | 30.2 | 19.0 / 19.0 |
| P5 DocumentReference | 45.0 | 32.4 | 16.0 / 15.6 |
| P6 Patient name+birthdate | 34.5 | 31.7 | 0.1 / 0.1 (almost always an empty result) |
| P7 ImagingStudy | 393.6 | 31.7 | 5.4 / 4.8 |
| P9 `_lastUpdated` scan | 96.1 | 31.0 | 100.0 / 100.0 |

Near-identical mean page sizes across engines show the two engines answer the same questions with the
same semantics on the same data, so the latency columns compare like with like (the small differences in
P3 MedicationRequest and P5 come from the random draws interleaving with writes, not verified).

L1 mix, 60 s, 8 threads: HAPI 128.3 req/s, p95 90.7 ms, 8,613 requests, 1 error (not diagnosed, below the
1 % abort threshold); Medplum 327.5 req/s, p95 47.6 ms, 19,656 requests, 0 errors. HAPI's first mix run
on the same database was 184.6 req/s, p95 115.5 ms (11,137 requests, 0 errors): a 44 % swing between two
runs of the same script, which bounds how much any single cell here can be trusted.

`$export` (system level, `Prefer: respond-async`, ndjson downloaded and counted): HAPI 103,477 resources
in 26.9 s (server-complete at 20.3 s) = 3,848.68 res/s; Medplum 103,971 resources in 6.5 s (server-complete
at 5.2 s) = 15,938.24 res/s. HAPI's earlier run: 103,060 resources, 36.4 s = 2,832.5 res/s. Export counts
exceed the load count because the mixes wrote Observations (about 5 % of requests) before each export; the
Medplum export count was not reconciled against its own live count plus mix writes. CAPACITY-MODEL s7 target is about 23 k res/s per stamp; these are
single-path, single-pod, laptop figures and say nothing about whether the parallel-worker design is needed
beyond the unsurprising fact that 3.8 k and 15.9 k are both below 23 k.

Observations to confirm in the sandbox: (a) HAPI's P7 p95 (394 to 402 ms in both runs) is 10x its other
patterns and 12x Medplum's on the same query, reproducibly; the cause is not diagnosed (candidates:
missing/unused index on `ImagingStudy.patient`, or result-cache behaviour on a pattern whose result
differs per patient). (b) P6 returned almost no hits, so its latency is a miss latency; the sandbox run
must sample names that exist. (c) The reported Medplum numbers are with rate limiting disabled; at
default settings Medplum throttled bulk loading (section 1.2), which matters for the W6 export/sink
design.

Controls: every pattern aborts the script if more than 1 % of its requests are non-2xx (a failing query
must not publish a latency), and the mix aborts on more than 1 % errors; `mean_hits_*` is recorded so an
empty-result pattern is visible. The abort thresholds were not mutation-tested (no failing engine was
available); they are asserted by construction only.

## 3. DICOM engine: dcm4chee-arc-light (W0-2, ADR-002 / ADR-004)

Scripts (authored at base `7da37991c`, branch `feat/lhds-w0-no-cost`; uncommitted at the time of writing):
`scripts/measure/health/dicom-engine-{deploy,load,ops,report}.sh`, plus `dicom-engine-lib.sh` and
`dicom-engine-gen.py` (synthetic DICOM generator; its instances are generated, never real images).

**Status: the W0-2 sandbox measurement was NOT performed.** No Azure resource was created and no `az` command was
run (operator decision 2026-10-22). `dicom-engine-deploy.sh` has never been run against a subscription; it was only
executed to prove its guards (refuses with no `LHDS_SANDBOX_SUBSCRIPTION`/`LHDS_SANDBOX_RG`; with both set and
`LHDS_DEPLOY_CONFIRM` unset it writes the values/manifests under `temp/` and prints a plan, touching nothing).
`dicom-engine-ops.sh blob` was never run against Blob.

### 3.1 Sandbox table (class-M stamp, AKS + PostgreSQL + Azure Blob, CMK, private endpoint)

| Cell | Value |
|---|---|
| STOW p95 at 100 concurrent senders, 512 KiB instance (ADR-002 bar: <= 300 ms) | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| STOW throughput (req/s, MiB/s) per pod | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| QIDO p95 / req/s | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| WADO p95 / req/s / MiB/s | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| Azure Blob descriptor works (Commercial endpoint) | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| Azure Blob descriptor with CMK | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| Azure Blob descriptor via private endpoint | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| Azure Blob descriptor against a Gov endpoint (`*.blob.core.usgovcloudapi.net`) | not measured: sandbox not provisioned (operator decision 2026-10-22); a Gov receipt must come from a GitHub Actions run |
| LDAP restart / backup on AKS (StatefulSet) | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| Blob 503 onset (first concurrency step returning HTTP 503) | not measured: sandbox not provisioned (operator decision 2026-10-22) |
| Orthanc same probe (only if dcm4chee fails its bar) | not measured: sandbox not provisioned (operator decision 2026-10-22); not triggered, since dcm4chee has no sandbox result |

ADR-002 status stays **Proposed**: no pass-bar value was measured.

Open gap found while authoring (not a measurement): the dcm4che wiki documents jclouds object storage only for S3
(identity / credential / container). The Azure Blob descriptor (`jclouds:azureblob:https://<acct>.blob.core.windows.net`,
shared key or SAS in `credential`) comes from ADR-002's reading of `dcm4chee-arc-storage-cloud` and is **unverified
against a running archive**. Shared-key/SAS auth also means no managed identity for pixel storage. The sandbox run
must settle both before ADR-002 and ADR-004 can be closed.

### 3.2 LOCAL SMOKE (NOT pass-bar evidence)

These numbers only show that the scripts run end to end and that the report fails when it should. They are **not**
evidence for any ADR-002 or ADR-004 bar: Windows 11 laptop, Docker Desktop (8 CPUs, ~37 GiB), **local filesystem
storage, not Blob**, no AKS, no CMK, no private endpoint, a Git Bash load driver, a single archive container, and the
other W0 lanes' containers sharing the machine. Measured 2026-10-22 at base `7da37991c` (scripts uncommitted).

Stack: the documented minimum set from the dcm4che wiki ("Run minimum set of archive services on a single host"):
`dcm4che/slapd-dcm4chee:2.6.15-35.2`, `dcm4che/postgres-dcm4chee:17.9-35`, `dcm4che/dcm4chee-arc-psql:5.35.2`
(containers `lhds-w0-l2-{ldap,db,arc}` on network `lhds-w0-l2-net`, all removed afterwards).

Run: `dicom-engine-load.sh` with `LHDS_DICOM_ENV_LABEL=local-smoke`, 200 synthetic CT instances (524,942 bytes each as
files, random pixel data = incompressible worst case, fabricated names, seeded UIDs, seed 43), 100 requested concurrent
`curl` senders, then the same count for QIDO (study lookup by StudyInstanceUID) and WADO (whole-instance retrieve),
then 3 more instances through the real `dcm4che/dcm4che-tools:5.35.1` `stowrs` client.

| Cell (local smoke, filesystem storage) | Value |
|---|---|
| STOW requests ok / sent | 200 / 200 (0 failed) |
| Archive instance count delta vs 200 acknowledged STOWs | +200 (before 40, after 240): persisted == acknowledged |
| STOW p50 / p95 / p99 | 32.4 ms / 696.4 ms / 1016.5 ms |
| STOW throughput | 31.9 req/s, 16.0 MiB/s |
| QIDO ok / sent; p95; throughput | 200 / 200; 923.9 ms; 26.2 req/s |
| WADO ok / sent (body >= 524,942 B each); p95; throughput | 200 / 200; 24.3 ms; 33.2 req/s, 16.6 MiB/s |
| Real-tool `stowrs` (dcm4che-tools 5.35.1), 3 instances | exit 0, archive count +3 |
| LDAP backup (`slapcat` -n 0 and -n 1) and restore into a fresh container of the same image | 1,599 data entries dumped, 1,599 restored (config: 14 entries) |
| LDAP restart (`docker restart`) to rootDSE answering | 0.8 s |
| First HTTP 200 STOW after the LDAP restart began | 1.0 s, no manual step |
| Blob 503 onset | not measured: filesystem storage locally, no Blob |

Report run: `dicom-engine-report.sh` over this result set **exited 1** with exactly one cell EMPTY (Blob 503 onset)
and printed `ADR-002 STOW bar: NOT PASS-BAR EVIDENCE (env=local-smoke ...)`. That is the guard working, not a defect
in the smoke.

Caveats that change how to read the numbers:
- **The Git Bash driver cannot deliver the requested concurrency.** Each request spawns bash + awk + curl. A
  positive-control run of the Blob ramp against a local fake endpoint (503 above 3 in-flight PUTs) asked for 60
  concurrent senders and the fake server observed a maximum of **14** in flight. The "100 senders" label above is the
  requested count, not the achieved one; the STOW/QIDO p95 values include spawn-storm contention. The sandbox run must
  use a Linux driver pod (the scripts run unchanged there) and the report's `stow_concurrency` cell records the
  request, so achieved concurrency should be logged server-side.
- LDAP restart and "archive recovered" only prove the archive keeps serving STOW across a 0.8 s slapd restart. They do not
  prove the archive re-reads configuration from LDAP, and they say nothing about a StatefulSet restart on AKS.
- Controls run: Blob-probe 503 detection against the fake endpoint (onset found at the 10-sender step, 26 of 30 PUTs
  returned 503); the report script returned 0 only on a result set where every cell was populated (a copy of the smoke
  metrics plus the fake-endpoint Blob cell, labelled local-smoke). The fake-endpoint value is a script control, not a
  measurement of Blob.
- The synthetic instance is a minimal CT with no overlay or multi-frame structure; real modality mix and sizes (the
  VA/IHS evidence in `research/scale-evidence-va-ihs-dicom-pricing.md`) are not represented.

## 4. Gov availability closure (W0-3)

**Receipt:** GitHub Actions run
[39887825372](https://github.com/fgarofalo56/csa-inabox/actions/runs/39887825372).

- Workflow `.github/workflows/health-w0-gov-probe.yml`, dispatched from `main`
  at `79141929f` (PR #5092, merged on the operator's approval 2026-10-22).
- Conclusion `success`. The job "Probe Azure Government availability
  (read-only)" executed 11 steps, so the run counts as a receipt.
- All 15 probes returned rc 0, per `status.tsv` in the run artifact.
- Identity: the existing Gov workflow identity, read-only calls only.
- Facts below come from the artifact, parsed locally on 2026-10-22.

### 4.1 PostgreSQL Flexible Server, usgovvirginia (Q1): NOT AVAILABLE to this subscription

`az postgres flexible-server list-skus --location usgovvirginia` returned one
capabilities record with:

- **zero** `supportedServerEditions`, **zero** `supportedServerVersions`, and
  **zero** storage editions;
- feature `OfferRestricted: Enabled`;
- `reason`: "Provisioning is restricted in this region. Please choose a
  different region. For exceptions to this rule please open a support request
  with Issue type of 'Service and subscription limits'."
- Zone-redundant HA is `Disabled`, as is zone-redundant HA with geo-backup.
  `GeoBackup` is `Enabled`.

Consequences:

- This contradicts `AZURE-GOV-AVAILABILITY.md`, whose PostgreSQL row reads
  "zone-redundant HA and geo-backup in Virginia only". For this subscription,
  Virginia offers no PostgreSQL at all until a support request lifts the
  restriction.
- E-series and SSD v2 cannot be assessed while zero SKUs are offered.
- Every LHDS engine (FHIR, DICOM metadata, terminology, MPI, audit index) sits
  on PostgreSQL. The Gov stamp is blocked on either (a) a support request for
  usgovvirginia, or (b) a region where this subscription is not restricted.
- **Not probed:** usgovarizona and usgovtexas, because the workflow is pinned to
  Virginia. Next step: add a region input and re-dispatch.

### 4.2 Resource providers (all `Registered`), Gov locations per resource type

| Resource type | Gov/DoD locations listed |
|---|---|
| ContainerService/managedClusters | USGov Arizona, Texas, Virginia |
| DBforPostgreSQL/flexibleServers | USGov Virginia, Arizona, Texas (listed, but see 4.1: Virginia is restricted for this subscription) |
| Storage/storageAccounts | USGov Virginia, Texas, Arizona; USDoD East, Central |
| EventHub/namespaces, EventHub/clusters | USDoD Central, East; USGov Arizona, Texas, Virginia |
| ApiManagement/service | USDoD Central, East; USGov Arizona, Texas, Virginia |
| KeyVault/vaults | USGov Virginia, Texas, Arizona; USDoD Central, East |
| KeyVault/managedHSMs | USGov Virginia, Arizona, Texas; USDoD East |
| Cdn/profiles | `global` |
| Network/frontDoors (classic) | resource type absent |
| Network/privateEndpoints, Network/azureFirewalls | all five Gov/DoD regions |
| LoadTestService/loadTests | **resource type absent**: Azure Load Testing is not offered, so Gov load tests need in-cluster drivers |
| App/managedEnvironments, App/containerApps | USGov Virginia, Arizona, Texas (region listing only; this is not IL5 audit scope) |

### 4.3 Region pairing (`az account list-locations`)

usgovvirginia pairs with usgovtexas, usgovarizona with usgovtexas, and
usdodcentral with usdodeast.

### 4.4 AKS (`az aks get-versions`)

Kubernetes 1.31 through 1.37 are offered in usgovvirginia, usgovarizona and
usgovtexas alike.

### 4.5 Still open (not establishable read-only; stated in the workflow)

- **Event Hubs Premium orderability:** only the resource-type locations were
  read. That a namespace can be listed there does not prove the Premium SKU can
  be ordered.
- **KEDA add-on:** availability is not established, because there is no
  per-cloud read API for it.

## 5. No-calls-home / egress check (W0-4)

Scripts: `scripts/measure/health/egress-capture.sh`, `egress-report.sh` (authored on the
`feat/lhds-w0-no-cost` worktree, base `7da37991c`).

### 5.1 Status: NOT EXECUTED

The 24-hour capture, per candidate engine image, needs the class-S AKS sandbox with an isolated node
pool. **not measured: sandbox not provisioned (operator decision 2026-10-22).** No Azure resource was
created and no `az` command was run. The local Docker run did not attempt an egress capture: a
laptop's Docker Desktop network has no isolated pool, no CoreDNS under our control and a host stack
generating unrelated traffic, so any list from it would not be a result for this question.

| Engine image | FQDNs observed over 24 h | Classification |
|---|---|---|
| HAPI FHIR JPA | not measured: sandbox not provisioned (operator decision 2026-10-22) | not measured |
| Medplum server | not measured: sandbox not provisioned (operator decision 2026-10-22) | not measured |
| DICOM engine candidates (W0-2 images) | not measured: sandbox not provisioned (operator decision 2026-10-22) | not measured |

### 5.2 Method (what the scripts do when run against the sandbox)

Two independent witnesses, because each has a blind spot:
1. **CoreDNS query log.** `egress-capture.sh start` applies the AKS `coredns-custom` ConfigMap with
   `log.override: log`, restarts CoreDNS, and `stop` filters the log by the client IPs of pods in the
   engine namespace (pod IPs are snapshotted at start, after every restart via `snapshot`, and at stop,
   because DNS rows are keyed by pod IP). Catches every name resolved; blind to IP literals.
2. **Packet witness.** A `hostNetwork` netshoot pod on the isolated node runs tcpdump keeping only new
   outbound TCP SYNs and UDP to non-RFC1918/link-local destinations. Catches IP literals and non-CoreDNS
   resolution; yields IPs, not names.

Isolation premise: the engine namespace is scheduled only onto a node pool labelled
`loom.io/pool=egress-probe` and tainted `loom.io/egress-probe=true:NoSchedule`. `egress-capture.sh`
refuses to run if the named node does not carry that label.

`egress-report.sh` classifies each FQDN as `in-cluster` (`*.svc`, `*.cluster.local`), `azure` (a fixed
suffix list covering Commercial and Gov: `azure.com`, `azure.us`, `windows.net`, `microsoftonline.com`,
`microsoftonline.us`, `azurecr.io`, `azurecr.us`, `usgovcloudapi.net`, `azmk8s.io`, and a few others) or
`non-azure`. Any `non-azure` FQDN is a finding (W0-4 verify rule).

### 5.3 Controls (assertion-design) and what was actually run

Exit codes of `egress-report.sh`, each named by the input that produces it, exercised on **hand-written
fixture lists in `temp/lhds-w0/l1/egress-fixtures/`. These are tests of the report script, not
measurements of any engine.**

| Fixture input | Expected | Observed |
|---|---|---|
| empty file | exit 2 (logging not wired, not a clean result) | exit 2 |
| only a `#` comment line | exit 2 | exit 2 |
| in-cluster + two Azure Gov names | exit 0 | exit 0 |
| in-cluster + Azure + `sentry.io` | exit 10 (finding) | exit 10, `sentry.io` classed non-azure |
| two Azure names, no in-cluster name | exit 3 (positive control fails) | exit 3 |
| nonexistent file | exit 1 | exit 1 |

`egress-capture.sh stop` additionally fails if 0 DNS rows come from engine pod IPs, so an unwired
capture cannot reach the report as an empty-but-clean list. `bash -n` and `shellcheck -x` are clean on
both scripts. `egress-capture.sh` itself was NOT executed (no cluster), so the `coredns-custom` log
format regex, the tcpdump filter and the `log.override` behaviour are **untested**; the DNS log-line
format used by the parser is CoreDNS's documented default and has not been checked against a real AKS
CoreDNS log.

### 5.4 Gaps to close at execution time

- The PRP asks for a positive control of "the Azure FQDNs every pod must reach". The report enforces an
  in-cluster name instead (every engine pod resolves its database service). Azure FQDNs reached by the
  node (ACR image pull, AKS control plane) are kubelet-level and do not appear in pod DNS, so a
  pod-keyed Azure positive control may legitimately be empty; the operator should decide whether to add
  Workload Identity token endpoint (`login.microsoftonline.*`) as a required entry once the pods use it.
- Azure Firewall / NSG flow logs were considered as an alternative witness and not scripted: they need a
  firewall or Log Analytics workspace in the sandbox (extra cost) and add no information over DNS plus
  tcpdump for a 24 h single-node capture.
- tcpdump packet output lists destination IPs only; mapping them back to names (for IP-literal calls) is a
  manual step in `packets-nonprivate.txt` and is not automated.

## 6. Synthea generation throughput and cohort manifests (W0-5)

Scripts (base `7da37991c`, branch `feat/lhds-w0-no-cost`; uncommitted at the time of writing):
`scripts/measure/health/synthea-{generate,manifest,upload}.sh`.

**Status: the in-pool measurement was NOT performed** (no Azure spend, operator decision 2026-10-22; no AKS pool exists).
Everything below is a laptop smoke and is **not** pool evidence.

| Cell | Value |
|---|---|
| Synthea throughput in the pool (patients/hour) | not measured: no pool |
| Largest cohort reachable in 48 h | not measured: no pool |
| Cohort manifests stored in Blob | not performed: `synthea-upload.sh` is a separate explicit opt-in step that needs a storage account and subscription env var (no default) and was not run |

### 6.1 Laptop smoke (NOT pool)

Environment: Windows 11 laptop, Docker Desktop (8 CPUs, ~37 GiB), `eclipse-temurin:17-jre` container
`lhds-w0-l2-synthea`, the dcm4chee smoke stack idling alongside. Synthea release **v4.0.0**
(`synthea-with-dependencies.jar`, sha256 `ed43c20ad40ba5c3bc724503a5af032715fe3c491620b766148e7c2361e6ecc1`, pinned and
checked by the script), seed 20261022 (`-s` and `-cs`), reference date 20261022 (`-r`), state Massachusetts,
FHIR R4 export, default thread count. Measured 2026-10-22.

| Cell (laptop, NOT a pool) | Run A | Run B |
|---|---|---|
| Patients requested (`-p`) | 30 | 30 |
| Patient bundles produced (files that are not hospital/practitioner) | 31 | 31 |
| Wall time, including JVM start and module load | 39.0 s | 25.4 s |
| Patients/hour (patient bundles / wall time x 3600) | 2,862 | 4,394 |
| FHIR resources (textual `resourceType` count, incl. 33 Bundle wrappers) | 34,568 | 34,568 |

Reading these: a 30-patient run is dominated by fixed JVM/module startup, so patients/hour here **understates**
steady-state throughput, and the 1.5x spread between two identical runs (the only difference is the machine's
background load) shows the figure is not stable at this size (cause not isolated; laptop background load is the suspect, unmeasured). 31 bundles for 30 requested is Synthea counting only
living patients against `-p` while also exporting the deceased. Neither number supports a 100 M-patient
extrapolation, and none is made.

Resource counts by type (run B): Observation 12,068; Procedure 3,122; DiagnosticReport 2,858; Claim, Coverage,
ExplanationOfBenefit and ServiceRequest 2,379 each; Condition 991; MedicationRequest 909; Encounter and
DocumentReference 1,470 each; Immunization 452; Patient 31; the rest are below 400 (full list in the manifest).

### 6.2 Manifest and its checks

`synthea-manifest.sh` wrote `manifest.json` (seed, Synthea version, jar sha256, host label, counts by type, one
sha256 per file; 33 files) and `manifest.sha256` (hash over the sorted per-file sha256 values) beside each cohort.
Controls run, each exiting 1: a cohort whose only bundle has no Patient (count 0); an empty `fhir/` directory; a
cohort whose Patient count (1) differs from the generation record (31 bundles).

Findings:
- **A fixed seed did not give byte-identical cohorts.** Runs A and B: the hospital and practitioner files hash
  identically and 30 of 31 patient bundles are byte-identical; one bundle differs (CarePlan content). Their
  manifest hashes differ for that reason. Cohort identity is therefore the **manifest hash**, not the seed. (File
  names also differ: hospital/practitioner files carry a wall-clock timestamp, so the manifest hash deliberately
  excludes file names.)
- The first draft of the generator wrote a record that the manifest step could not source when the host label held
  spaces or parentheses; found by running it and fixed (values are now shell-quoted).

## 7. Loom integration measurements (W0-6)

Measured 2026-10-22 at `origin/main` = `b192f05ea347086c772af1cb876d94fc845083c8`
(confirmed with `git fetch` + `git rev-parse origin/main`), read with
`git grep -n <pat> b192f05ea... -- <paths>` and `git show b192f05ea:<path>` run
from the repo root `E:/Repos/GitHub/csa-inabox-lhds-w0` (not the working tree,
which is the docs branch). No Azure resource touched, no `az` run, no workflow
dispatched. Paths below are repo-relative and refer to that SHA.

### 7.1 Summary

| # | Fact | Measured at b192f05ea | PRP assumption | Verdict |
|---|---|---|---|---|
| 1 | `backingStore` field exists in code | No. 0 hits in `apps/fiab-console/lib/catalog`; only a comment mentioning it as future work at `apps/fiab-console/lib/governance/backing-resolver.ts:85` | `LOOM-INTEGRATION.md:19-20`: "populated once the governance-autopilot W2 field lands (that PRP adds `backingStore`)" | CONFIRMED (not yet landed; W2 still ahead) |
| 2 | `ESTATE_PAUSE_TIER` entries | 10 entries, `apps/fiab-console/lib/estate/pause-tier.ts:27-41` | `LOOM-INTEGRATION.md:102` and `OPERATIONS-AND-BCDR.md:182`: AKS managed clusters and Container Apps are in the tier | CONFIRMED |
| 3 | `apimSku` usage | Required param (no default) `platform/fiab/bicep/main.bicep:64`; see 7.4 | `AZURE-GOV-AVAILABILITY.md:37,67`, `RISKS-AND-OPEN-DECISIONS.md:15`: Loom parameterises `apimSku`; classic Premium in Gov | CONFIRMED |
| 4 | `boundary` enum | `@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])` at `platform/fiab/bicep/main.bicep:20` (param at :21); no `DoD` | `ARCHITECTURE.md:174`, `RISKS-AND-OPEN-DECISIONS.md:12`: enum lacks DoD at `main.bicep:20` | CONFIRMED |
| 5 | `containerPlatform` per param file | All 7 param files set `'containerApps'`; none sets `'aks'`; see 7.5 | `adr/ADR-009-compute-platform-aks.md:7-8`: ContainerApps in every boundary file incl. IL5 (`il5.bicepparam:121`). BUT `ARCHITECTURE.md:88-90` and `AZURE-GOV-AVAILABILITY.md:23`: "AKS at IL5/DoD (existing `containerPlatform` switch)" | CONTRADICTED within the PRP set, see 7.5 |
| 6 | GHSA-g7m7 existence and deploy state | Advisory exists, state `draft` (private, unpublished). Fix deploy: see 7.6 | `RISKS-AND-OPEN-DECISIONS.md:48` (Q7) and `OPERATOR-DECISIONS-2026-10-22.md:38`: "not yet verified" | Q7 partly established, see 7.6 |
| 7 | #4584 state | OPEN, closedAt null | `LOOM-INTEGRATION.md:76`, `RISKS-AND-OPEN-DECISIONS.md:59`: Gov image lanes lack Trivy/cosign | CONFIRMED |

### 7.2 Fact 1 - `backingStore` (governance-autopilot W2)

- `git grep -n "backingStore" b192f05ea` over the whole repo returns 6 lines:
  5 are in `PRPs/active/governance-autopilot/PRP.md` (lines 96, 121, 249, 397;
  line 96 says the catalog "has **no `backingStore` field**") and 1 is
  `apps/fiab-console/lib/governance/backing-resolver.ts:85` (a doc comment: "W2
  adds the key (the `backingStore` field on the item catalog)").
- `git grep -n backingStore b192f05ea -- apps/fiab-console/lib/catalog` returns 0 hits.
  Positive control (same two files where W2 would add the field,
  `lib/catalog/fabric-item-types.ts` and `lib/catalog/item-types/types.ts`):
  `git grep -c "FabricItemType"` finds 6 and 2 matches respectively, so the
  pathspec resolves and the zero is real.
- Conclusion: the field does not exist in code at main; it is planned work
  (governance-autopilot W2, `PRPs/active/governance-autopilot/PRP.md:397`). LHDS
  must not read `backingStore` before that PRP's W2 merges. Related existing
  seam: `BACKED_WITHOUT_DOCUMENTED_KEY` in `backing-resolver.ts:87`.

### 7.3 Fact 2 - `ESTATE_PAUSE_TIER`

`apps/fiab-console/lib/estate/pause-tier.ts:27-41` at b192f05ea, 10 entries
(lower-cased ARM types):

1. `microsoft.synapse/workspaces/sqlpools` (:28)
2. `microsoft.kusto/clusters` (:29)
3. `microsoft.analysisservices/servers` (:30)
4. `microsoft.compute/virtualmachinescalesets` (:31)
5. `microsoft.compute/virtualmachines` (:35)
6. `microsoft.containerservice/managedclusters` (:36)
7. `microsoft.app/containerapps` (:37)
8. `microsoft.streamanalytics/streamingjobs` (:38)
9. `microsoft.web/sites` (:39)
10. `microsoft.databricks/workspaces` (:40)

(Lines 28-31 hold 4, lines 35-40 hold 6.) `OUT_OF_TIER_REASONS` is an
empty record (:48). Consequences for LHDS: AKS clusters and Container Apps are
already in the tier, as the PRP assumes. PostgreSQL Flexible Server
(`microsoft.dbforpostgresql/flexibleservers`) and Event Hubs namespaces are NOT
in the tier, so only the AKS cluster of a stamp would be touched by idle
auto-pause; the PRP's `health-stamp` guard is needed for exactly that reason.
Test pin: `lib/estate/__tests__/pause-orchestrator.test.ts:679`.

### 7.4 Fact 3 - `apimSku`

At b192f05ea, `git grep -n apimSku -- platform/`:

| Where | file:line | Value |
|---|---|---|
| Declaration, required, no default, `@allowed(['PremiumV2', 'Premium'])` | `platform/fiab/bicep/main.bicep:62-64` | n/a |
| Passed to admin-plane | `platform/fiab/bicep/main.bicep:1306` | n/a |
| Admin-plane param | `platform/fiab/bicep/modules/admin-plane/main.bicep:42` | n/a |
| Used as APIM `sku` | `platform/fiab/bicep/modules/admin-plane/main.bicep:3797` | n/a |
| `params/commercial-full.bicepparam:17` | | `PremiumV2` |
| `params/commercial.bicepparam:107` | | `PremiumV2` |
| `params/gcc.bicepparam:131` | | `PremiumV2` |
| `params/tenant-dmlz.bicepparam:54` | | `PremiumV2` |
| `params/gcc-high.bicepparam:125` | | `Premium` |
| `params/il5.bicepparam:123` | | `Premium` |
| `params/dlz-attach.bicepparam` | no `apimSku` line | not set (DLZ-attach topology) |

Separate, unrelated param `apimSkuName` (default `'Developer'`) at
`main.bicep:934`; do not confuse. Matches the PRP's "classic Premium in Gov".

### 7.5 Fact 4 and 5 - `boundary` enum and `containerPlatform` per param file

`boundary`: `platform/fiab/bicep/main.bicep:20` is
`@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])`, param at :21. The same
four-value list is repeated as a single-line decorator in 18 module files under `platform/fiab/bicep/modules/` (`git grep -l` gave 19 files including `main.bicep`), plus a multi-line list in `modules/copilot/copilot-chat-function.bicep` and a narrower `['GCC-High', 'IL5']` in `modules/copilot/maf.bicep:49`
(for example `admin-plane/main.bicep:10`, `landing-zone/main.bicep:10`), so
adding `DoD` (decision D3) is an edit in every one of those decorators, not only
`main.bicep`. Zero-hit control: `git grep -n "'DoD'" -- platform/fiab/bicep/main.bicep`
returns 0, and `git ls-tree` for `params/dod.bicepparam` returns 0 entries, while
the same `main.bicep` line :20 contains `'IL5'` and `params/il5.bicepparam`
exists, so the pathspec is valid and DoD is genuinely absent.

`containerPlatform`: declared at `platform/fiab/bicep/main.bicep:54-56`,
`@allowed(['containerApps', 'aks'])`, **no default** (a param file must set it).
Population: `git ls-tree -r --name-only b192f05ea -- platform/fiab/bicep/params/`
lists exactly 7 files; all 7 set it, so no default applies to any of them.

| Param file | `boundary` | `containerPlatform` | file:line |
|---|---|---|---|
| `commercial-full.bicepparam` | Commercial | `containerApps` | :15 (boundary :9) |
| `commercial.bicepparam` | Commercial | `containerApps` | :100 (boundary :94) |
| `gcc.bicepparam` | GCC | `containerApps` | :108 (boundary :102) |
| `gcc-high.bicepparam` | GCC-High | `containerApps` | :123 (boundary :110) |
| `il5.bicepparam` | IL5 | `containerApps` | :121 (boundary :107) |
| `tenant-dmlz.bicepparam` | Commercial | `containerApps` | :52 (boundary :34) |
| `dlz-attach.bicepparam` | Commercial | `containerApps` | :44 (boundary :37) |

Count: 7 of 7 files `containerApps`, 0 of 7 `aks`, 0 of 7 unset. (The
`main.bicep:55` description text, "AKS (GCC-H/IL5)", is a comment and is
contradicted by the params; the `il5.bicepparam:121` and `gcc-high.bicepparam:123`
comments say ACA is GA in USGov.)

**PRP assumption check - CONTRADICTED inside the PRP set.**
- Assumes AKS at IL5 via the existing switch: `ARCHITECTURE.md:88-90` ("an AKS
  Deployment at IL5, via the existing `containerPlatform` switch"),
  `AZURE-GOV-AVAILABILITY.md:23` ("AKS at IL5/DoD (existing `containerPlatform`
  switch)"), `LOOM-INTEGRATION.md` (W1-3 row in `W01-control-plane-identity-stamp.md:29`
  "AKS Deployment at IL5 via `containerPlatform`").
- Measured: `params/il5.bicepparam:121` is `containerApps`. The switch exists but
  no shipped boundary file selects `aks`.
- The PRP set already knows part of this: `adr/ADR-009-compute-platform-aks.md:6-8`
  cites `il5.bicepparam:121` and `gcc-high.bicepparam:123` as `containerApps`. So
  ADR-009 is consistent with the measurement; ARCHITECTURE.md, AZURE-GOV-AVAILABILITY.md
  and W1-3 are not. Implication for W1-3: running the control plane on AKS at IL5
  means either an `il5.bicepparam` flip of `containerPlatform` (which changes the
  whole Loom admin plane, not only LHDS) or a separate health-only AKS path; the
  wording "via the existing switch" understates that. Left for the W0-7 decision
  pass; not edited here.

### 7.6 Fact 6 - GHSA-g7m7 existence and deploy state (existence only)

Public repo: this section deliberately carries no advisory body, no fix PR
number, no commit and no affected-component description (operator convention:
public surfaces stay neutral until patched AND deployed on every estate).

- Existence: a private advisory with the `g7m7` id prefix exists, `state: draft`
  (unpublished), read 2026-10-22 via the repository security-advisories API; only
  the id and state fields were read.
- Commercial: the candidate fix is an ancestor of `b192f05ea`, and the live
  Commercial console build marker reported `sha=b192f05ea...` on 2026-10-22, so
  "candidate fix contained in the live Commercial build" is established. The
  fix-to-advisory link and the measurement detail are held by the operator, not
  recorded here.
- Not established: (a) that the candidate fix is the complete fix (needs the
  advisory body / operator); (b) the deployed state on the Gov consoles
  (GCC-High, IL5), which needs a GitHub Actions read, not a workstation call.
  Q7 asks about every estate the sink runs on, so it is only partly answered and
  the `health-lakehouse-isolation` gate stays as written for Gov.

### 7.7 Fact 7 - issue #4584

`gh issue view 4584 --json state,title,closedAt,number` (2026-10-22):
`state: OPEN`, `closedAt: null`, title "cloud-parity: the Gov runner-image lane
builds and pushes with NO supply-chain gate - 0 trivy, 0 cosign, against 9/36 on
Commercial". Confirms `LOOM-INTEGRATION.md:76` and `RISKS-AND-OPEN-DECISIONS.md:59`
(R3, Q8). Not re-measured: whether the lane still has 0 trivy / 0 cosign today
(the issue title is the issue's claim, not my count).

### 7.8 Not measured

- Gov (GCC-High, IL5) deploy state of the lakehouse-isolation fix (7.6 b).
- Whether the candidate fix is the complete fix (7.6 a).
- Current trivy/cosign counts on the Gov image lane (7.7).
- Nothing here exercises a deploy; these are source and metadata reads.

## 8. Decision (W0-7)

**Not started.** ADR-001, ADR-002, ADR-003 and ADR-004 stay at `Proposed`.
`CAPACITY-MODEL.md` section 1.3 is unchanged. Moving any of these on local-smoke
numbers would claim a result this receipt did not establish.

What the decision pass needs:

1. Q2: the sandbox budget approved, and its subscription named.
2. The sandbox run of W0-1, W0-2, W0-4 and W0-5, using the scripts in
   `scripts/measure/health/`. Load drivers run as Linux pods, not Git Bash.
3. Q1 resolved for the Gov stamp: a support request for PostgreSQL in
   usgovvirginia, or a re-dispatch of the probe for usgovarizona and
   usgovtexas (section 4.1).
4. Questions for the decision pass to carry from the local findings:
   - Is 4.5 KB per resource realistic, or should the capacity model move toward
     the roughly 10 KB measured here and cited by ADR-001?
   - Does dcm4chee's Blob storage work with managed identity at all?
   - Does Medplum keep failed transactions atomic, and does its rate limiting
     shape the W6 export design?

The tracking issue and the W1 bicep issue named in W0-7 are not filed. They are
filed at the decision pass.
