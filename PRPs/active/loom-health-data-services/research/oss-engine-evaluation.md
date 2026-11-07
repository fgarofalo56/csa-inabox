# OSS protocol-engine evaluation — FHIR, DICOM, viewers, converters, de-id, test data

Retrieved 2026-10-22. Target: AKS + Azure Database for PostgreSQL (Flexible) + Blob Storage,
Azure Commercial AND Azure Government, no calls home, very large scale.

Method: GitHub REST (`gh api` / unauthenticated `api.github.com` for the `microsoft` org, which is SAML-gated on
this token), vendor docs, CISA/NVD advisories, and one independent third-party benchmark. Every number carries a URL
or is marked UNVERIFIED. "Commits/90d" = commits since 2025-07-24 on the default branch (GitHub commits API,
paginated). "Contributors" = GitHub contributors-API page count (`per_page=1&anon=true`, so it includes anonymous
authors). The `pushed_at` field is the last push to ANY branch, not the last release.

Legend for license column: **P** = permissive, **WC** = weak copyleft (MPL/EPL/LGPL), **SC** = strong copyleft
(GPL/AGPL), **C** = commercial/source-available, **?** = not confirmed from a LICENSE file.

---

## 1. FHIR servers

### 1.1 Facts table

| Name | Repo | License | Runtime | PostgreSQL | Blob/S3 for Binary | FHIR | Latest release | Commits/90d · open issues · contributors |
|---|---|---|---|---|---|---|---|---|
| HAPI FHIR (JPA) + jpaserver-starter | github.com/hapifhir/hapi-fhir · github.com/hapifhir/hapi-fhir-jpaserver-starter | Apache-2.0 (**P**, API) | Java 17+, Spring Boot | **Yes** (supported dialect; starter Helm chart defaults to Postgres) | Binary stored in DB by default; external binary storage is a pluggable `IBinaryStorageSvc` (filesystem impl shipped; Blob/S3 impl is your code — UNVERIFIED for an official Azure impl) | DSTU2/DSTU3/R4/R4B/R5 | v8.8.2 2026-09-25; chart helm-v0.25.0 2026-10-20 (AppVersion 8.8.0) | 756 · 1,668 · 349 |
| Microsoft fhir-server | github.com/microsoft/fhir-server | MIT (**P**, API) | .NET (C#) | **No** — SQL Server (Azure SQL) and Cosmos DB only; Cosmos provider support ends 2026-09-30 per README; PostgreSQL requested in issue #1117 (closed, never merged) | Azure Blob for export/import; DICOM/Binary via Blob | R4 (R4B support ends 2026-07-01 per README); STU3 older | release/5.2.6 2026-10-18 | 100+ (first page full) · 163 · n/a |
| LinuxForHealth FHIR (ex-IBM) | github.com/LinuxForHealth/FHIR | Apache-2.0 (**P**) | Java | Yes (Postgres, Db2, Derby) | Azure Blob/S3 for bulk export | R4/R4B | last push 2024-04-18; `archived` flag false but **0 commits/90d** — effectively dormant | 0 · 370 · n/a |
| Medplum | github.com/medplum/medplum | Apache-2.0 (**P**, API) | TypeScript / Node.js | **Yes — Postgres-only** (+ Redis required) | **Azure Blob** (`packages/server/src/cloud/azure/storage.ts`), S3, GCS, filesystem | R4 | v5.2.7 2026-10-20; Helm chart 5.2.7 at charts.medplum.com (index.yaml, 2026-10-20) | 2,370 · 713 · 200 |
| Blaze (samply) | github.com/samply/blaze | Apache-2.0 (**P**, API) | Clojure / JVM | **No** — embedded RocksDB; "distributed" variant = Kafka tx-log + Cassandra store (blaze-server.org/deployment/distributed-backend.html) | No (resources in RocksDB/Cassandra) | R4 (CQL engine built in) | v1.12.0 2026-10-22 | 1,437 · 227 · 23 |
| Pathling (CSIRO) | github.com/aehrc/pathling | Apache-2.0 (**P**) | Java / Spark | n/a — analytics over Parquet/Delta, not a transactional server | Any Spark FS | R4 | v10.0.0 2026-10-21 | 2,633 · 135 · n/a |
| Spark FHIR (Firely) | github.com/FirelyTeam/spark | BSD-3-Clause (**P**) | .NET | No — MongoDB | n/a | STU3/R4 | v3.2.1 2026-10-18 | 550 · 34 · n/a |
| fhir-works-on-aws | github.com/awslabs/fhir-works-on-aws-deployment | Apache-2.0 | TypeScript | No — DynamoDB | S3 | R4 | **ARCHIVED** (API `archived: true`, last push 2023-04-13) | 0 · 0 · n/a |
| fhir-data-pipes (ex-Google, now ohs-foundation) | github.com/ohs-foundation/fhir-data-pipes | Apache-2.0 | Java/Beam | n/a (ETL to Parquet) | — | R4 | pushed 2026-10-15 | — |
| HL7 FHIR Validator (core) | github.com/hapifhir/org.hl7.fhir.core | Apache-2.0 | Java | n/a | n/a | all | 7.0.3 2026-10-21 | · 136 · |
| Inferno core | github.com/inferno-framework/inferno-core | Apache-2.0 | Ruby | n/a | n/a | test kits: g(10) kit v8.0.7 (inferno.healthit.gov) | v1.5.0 2026-10-21 | · 24 · |
| Firely Server / Smile CDR / Aidbox / Kodjin | — | **C** (commercial; Aidbox & Smile have free dev tiers) | .NET / Java / Clojure / — | Firely: SQL Server+Mongo; Smile: Postgres (HAPI); Aidbox: Postgres | — | R4/R5 | — | comparison only |

### 1.2 Conformance, scale, scaling model, security, telemetry

**HAPI FHIR**
- Conformance: the open-source server is NOT itself ONC-certified; Smile CDR (built on HAPI) holds §170.315(g)(10)
  via Drummond, 2022-12-20 (smiledigitalhealth.com/our-blog/smile-digital-health-achieves-g10). The Inferno
  reference server IS a HAPI JPA server (github.com/inferno-framework/inferno-reference-server), i.e. HAPI + an
  external SMART authorizer + bulk export passes the g(10) kit.
- Published scale (independent, vendor-of-competitor run, 2026-06-28, 8 vCPU/24 GB app + PG18 8 vCPU/30 GB):
  3,058 CRUD RPS; p99 create 276 ms; 2,214 res/s transaction-bundle import; 1,005 search RPS; **22.6 GB** DB after
  ~2 M resources (vs 6.83 GB Aidbox, 11.8 GB Medplum, 4.24 GB MS) — health-samurai.io/articles/performance-at-scale-baseline.
  Older: 5 instances on one PG → ~1,000 res/s then duplicate-key race on `hfj_spidx_quantity_pkey`
  (hapi-fhir-jpaserver-starter issue #48, 2019). CMS Blue Button 2016: 82 bundle tx/s (groups.google.com/g/hapi-fhir/c/yNCsibiBK80).
- Scaling model: stateless app pods over ONE relational schema (`HFJ_RESOURCE`, `HFJ_RES_VER`, `HFJ_SPIDX_*`).
  Horizontal = add pods + Postgres read replicas (search-only) + Elasticsearch/Lucene offload. Partitioning
  (hapifhir.io/hapi-fhir/docs/server_jpa_partitioning/partitioning.html): tenant/patient-ID partitions in one DB;
  conformance resources must live in the default partition; cross-partition `_history` unsupported.
  **Database Partition Mode** (8.0.0, experimental, db_partition_mode.html): partition id in every PK and JOIN so
  the RDBMS can natively partition/shard; new deployments only, no migration, MDM unsupported. True multi-database
  sharding ("MegaScale", partitions→schemas→physical DBs; 15,000 patient-ID partitions → N shards) is **Smile CDR
  commercial only** (smilecdr.com/docs/fhir_storage_relational/megascale.html).
- Containers/K8s: official `hapiproject/hapi` image (distroless + tomcat flavours), official Helm chart with HPA
  (1→10 pods @60% CPU) and PDB; PG subchart or external DB.
- Calls home: none found in server; starter has no telemetry hook. UNVERIFIED by packet capture.
- Security: no built-in auth — you supply an interceptor/authorizer (SMART via Keycloak/Smile/Entra). CVEs in 2025
  are transitive deps (Tomcat CVE-2025-48988/-48989/-55668, commons-lang CVE-2025-48924) plus CVE-2025-66021 via
  owasp-java-html-sanitizer affecting hapi-fhir ≤8.6.8 (vulners.com). No 2025 CVE in HAPI's own server code found.
- Governance: Smile Digital Health is steward; single-vendor project, very large contributor base.

**Microsoft fhir-server**
- PostgreSQL: **not supported** (README names SQL + Cosmos only; issue #1117 closed unmerged). Disqualifying for
  the stated target. Conformance: AHDS FHIR service is HITRUST-certified; no CHPL g(10) listing found for Microsoft
  (search 2026-10-22). Scale: 440 CRUD RPS / 448 res/s import on SQL Server 2022 in the same benchmark (lowest).
  Security: Entra-native; SMART via Azure AD. Health: very active (100+ commits/90d), 163 open issues.
  Not Gov-portable as OSS on Postgres. **Excluded on backend grounds, not quality.**

**Medplum**
- Conformance: **ONC-certified**, CHPL 15.04.04.3147.Medp.05.03.1.251231, cert date 2025-12-31, product "Medplum 5";
  g(10) on US Core 5.0.1 + SMART App Launch 2.0.0 + Bulk Data; criteria a2,a5,a14,b1,b10,b11,c1,d1–d7,d9,d12,d13,
  g3–g7,g9,g10 (medplum.com/docs/compliance/onc). Real-World-Testing plans 2024/2025 linked there.
- Scale (same independent benchmark, 8 × 1 vCPU/3 GB pods + PG18 + Redis): 1,420 CRUD RPS; p99 create 758 ms;
  764 res/s import; 1,796 search RPS; 11.8 GB; **no composite search**. Vendor claims ">20 M patients",
  ">120 M workflow actions" (medplum.com/docs/self-hosting/scaling — stat tiles rendered "0M+", so UNVERIFIED).
- Scaling model: stateless Node API pods, Redis for cache/pubsub, `readonlyDatabase` config for a Postgres read
  replica (docs/self-hosting/config-settings). Multi-tenancy via **Projects** (resource-level isolation, `meta.project`,
  super-admin project, read-only project links — docs/access/projects). Storage is Postgres-only; no sharding story
  beyond read replicas; `Binary` content in Blob/S3/GCS/FS.
- Containers/K8s: official image + Helm chart (charts.medplum.com) + Terraform for AKS/PG Flexible/Blob/Front Door/
  Key Vault (docs/self-hosting/install-on-azure — page warns "significant operational expertise").
- Calls home: no usage telemetry found; OTel export is off unless `OTLP_*_ENDPOINT` set (docs/self-hosting/opentelemetry).
  Sample config ships Medplum-owned Google client id / reCAPTCHA keys — replace them. UNVERIFIED by packet capture.
- Security: built-in OAuth2/OIDC server, SMART App Launch 2.0.0 (standalone + EHR launch, `$smart-launch`,
  scopes v2), external IdP. 2026 CVEs: CVE-2026-53728 (open redirect, <5.1.6), CVE-2026-44506 (client_secret
  disclosure 4.1.10–5.1.6), CVE-2026-49120 (subscription SSRF <5.1.14). All patched; run ≥5.1.14.
- Governance: Medplum Inc (YC S22), single-vendor, 2,370 commits/90d.

**Blaze** — production at 35/41 German MII sites, aggregate >20 M patients / ~2 B lab values; largest single
instance 2 M patients / 400 M resources (DOI 10.3233/SHTI260455; devdays.com 2025 slides). CQL throughput up to
~1.9 M patients/s on a 100k-patient set (blaze-server.org/performance.html). Storage is RocksDB or Kafka+Cassandra —
not Postgres/Blob, no SMART, no official Helm, 23 contributors. Excellent research/CQL engine; wrong backing store
for this target.

**LinuxForHealth FHIR** — dormant (0 commits/90d, 370 open issues). **fhir-works-on-aws** — archived.
**Spark** — MongoDB only. **Pathling** — analytics layer (Spark/Parquet), a complement not a server.

---

## 2. DICOM servers

### 2.1 Facts table

| Name | Repo | License | Runtime | PostgreSQL | Object storage | DICOMweb / DIMSE | Latest release | Commits/90d · issues · contributors |
|---|---|---|---|---|---|---|---|---|
| Microsoft dicom-server | github.com/microsoft/dicom-server | MIT (**P**) | .NET | **No** — SQL Server + Azure Blob | Azure Blob | STOW/WADO/QIDO, extended query tags, change feed, UPS, export; DICOM Cast → FHIR | **10.0.838 2024-03-01 — server code removed from `main`, moved to `archived` branch; archival announced 2024-03-28 (discussion #3401)**; only NuGet client libs remain | 0 · 19 · n/a |
| dcm4chee-arc-light | github.com/dcm4che/dcm4chee-arc-light | **MPL-1.1 / GPL-2.0+ / LGPL-2.1+ tri-license** (per-file headers; dcm4che.atlassian.net/wiki/display/proj/License). GitHub API returns no SPDX; `LICENSE.txt` exists at root but 404'd via contents API — treat as **WC** (choose MPL-1.1 or LGPL-2.1) | Java EE on WildFly (image "Wildfly EE 10 41.0.0"), OpenLDAP (config), Keycloak (auth), optional ELK | **Yes** — `dcm4che/postgres-dcm4chee` PG 12–18 is the primary documented DB; MariaDB/Oracle/MSSQL schemas exist | Filesystem; `dcm4chee-arc-storage-aws-s3` (AWS SDK); `dcm4chee-arc-storage-cloud` (jclouds → **Azure Blob**, GCS, Swift); EMC ECS. Multi-storage, nearline, external-retrieve | QIDO-RS, WADO-RS, WADO-URI, STOW-RS, **UPS-RS** (`dcm4chee-arc-ups-rs`), IAN, STGCMT, MWL-RS, PDQ, FHIR client, HL7v2 (modules listed in repo root) + full DIMSE (C-STORE/FIND/MOVE/GET, MWL, MPPS, StgCmt) | 5.35.2 2026-10-15 | 370 · 206 · 21 |
| Orthanc | hg: orthanc.uclouvain.be/hg/orthanc (GitHub jodogne/Orthanc is a stale 2020 mirror) | Core **GPL-3.0+ (SC)**; PostgreSQL plugin **AGPL-3.0+**; DICOMweb plugin **AGPL-3.0**; object-storage (Azure/S3/GCS) **AGPL-3.0** (source headers; "proprietary cloud integrations … not freely updated without a support contract" per Book); plugins may not be MIT/BSD/Apache (orthanc.uclouvain.be/book/faq/licensing.html) | C++ | **Yes** via PostgreSQL plugin (v10.2 current); SQLite default | Azure Blob / S3 / GCS plugin, hybrid mode, client-side AES-256-GCM (book/plugins/object-storage.html) | DICOMweb plugin: QIDO/WADO-RS/WADO-URI/STOW; no UPS-RS found (UNVERIFIED) + DIMSE | 1.13.0 2026-08-15 (NEWS) | n/a (hg) · n/a · single lead maintainer (UCLouvain) |
| Dicoogle | github.com/dicoogle/dicoogle | **GPL-3.0 (SC)** | Java | Plugin-based index (Lucene default) | Plugin | DICOMweb partial (community) | 3.6.0 2026-05-18 | 52 · 60 · n/a |
| dicomweb-server (dcmjs) | github.com/dcmjs-org/dicomweb-server | Apache-2.0 | Node.js | No (LevelDB) | FS | QIDO/WADO/STOW | last push 2026-04-14 | · 25 · |
| Kheops | github.com/OsiriX-Foundation/kheops | **? no LICENSE file at root** (project site says GPLv3 — UNVERIFIED) | Java (auth/PEP/DICOMweb proxy over a **dcm4chee** backend) | via dcm4chee | via dcm4chee | proxy | last push 2025-01-02; `KheopsAuthorization` archived | · 20 · |

### 2.2 Conformance, scale, scaling model, security, telemetry

**dcm4chee-arc-light**
- Conformance: DICOM Conformance Statement repo (github.com/dcm4che/dcm4chee-arc-cs), HL7 CS repo, IHE Integration
  Statement for v5.34.3 (wiki/IHE-Integration-Statement, Dec 2025). IHE uses dcm4chee Archive 5 as the central
  archive for Connectathon tooling (wiki.ihe.net/index.php/Connectathon_Tool_Installation). No Connectathon
  results-DB entry located (UNVERIFIED).
- Published scale: lead dev's own production ">1 million studies" and ">100,000 objects a day" (groups.google.com/
  g/dcm4che/c/z3noPet4sw4, c/1qLIauL4p6c — 2020/21 forum posts, not a benchmark). No formal throughput benchmark.
- Scaling model: stateless-ish WildFly nodes sharing one PG + LDAP config; storage descriptors per node/cluster;
  nearline/external-retrieve tiers. No official partitioning; PG is a single schema (Patient→Study→Series→Instance→
  Location). K8s: wiki guide only (plain Deployments, hostPath, 1 replica) — **no official Helm chart**; community
  charts are ad-hoc (community.openintegrator.com/t/dcm4chee-kuberenetes-deployment/150).
- Calls home: none found. Keycloak/ELK optional. UNVERIFIED by capture.
- Security: Keycloak OIDC for UI/REST; DIMSE AE whitelist. **CISA ICSMA-26-288-02 (2026-10-16)**: CVE-2026-105279
  (CVSS 9.1, default config accepts unregistered calling AEs → C-FIND/C-GET/C-STORE), CVE-2026-97851 (9.1, storage
  status REST missing authz), CVE-2026-105667 (7.5, HL7 ADT^A40 merge unauthenticated), CVE-2026-105273/-107621/
  -101021 (parser DoS). All fixed in **5.35.2** (released the day before). Hardening: register AEs, authenticate HL7.
- Governance: J4Care (commercial sponsor) + dcm4che.org; 21 contributors, effectively one core author.

**Orthanc**
- Conformance: DICOM conformance statement in source tree; widely used in research; no IHE statement found.
- Published scale: production ">65 TB, 340,000 studies, ~150 M instances" (book/faq/scalability.html); PG ingest
  ~250 instances/s with 5 clients while SQLite degrades past 25k instances (book/faq/db-benchmark.html, 25.10.3 images);
  a 350k-study/150 M-instance/75 TB DB upgrade took ~50 h (book/plugins/postgresql.html).
- Scaling model: since 1.9.2 + PG plugin 4.0, multiple Orthanc writers/readers share one PG (transaction replay on
  collision; ReadCommitted default from plugin 7.0, 50 connections). Typical: 1 writer + N DICOMweb/viewer readers.
  Single PG schema, no partitioning. K8s: official `orthancteam/orthanc` images; Helm only community
  (digihunch/korthweb, fnndsc/charts).
- Security: HTTP basic/OIDC via plugins. **CVE-2025-0896** CVSS 9.8 (no auth by default when remote access enabled,
  <1.5.8; CISA ICSMA-25-037-02) and **CVE-2026-87020** CVSS 8.1 (image decode heap overflow <1.13.0; ICSMA-26-253-02).
- Licensing is the blocker: GPLv3 core + AGPLv3 for exactly the plugins this platform needs (PostgreSQL, DICOMweb,
  Azure Blob). Any linked product must be GPL/AGPL; the Azure plugin is maintained only under paid support.

**Microsoft dicom-server** — archived; MIT code on `archived` branch is SQL Server + Blob. Useful as a reference
for Azure-shaped change-feed/extended-tag/UPS design, and its `Microsoft.Health.Dicom.Client` NuGet is live. Not a
candidate engine.

---

## 3. Viewers

| Name | Repo | License | Notes |
|---|---|---|---|
| OHIF Viewer | github.com/OHIF/Viewers | MIT (**P**) | v3.13.13 2026-10-16; 862 commits/90d; 589 issues; 193 contributors. DICOMweb-native (QIDO/WADO-RS/WADO-URI/STOW), OIDC. Official Docker image `ohif/app`. No IHE statement found (UNVERIFIED). Works against dcm4chee and Orthanc. |
| Cornerstone3D | github.com/cornerstonejs/cornerstone3D | MIT | v5.13.1 2026-10-16; 1,002 commits/90d. Rendering engine under OHIF. |
| Weasis | github.com/nroduit/Weasis | **EPL-2.0 OR Apache-2.0** (LICENSE file SPDX line) | v4.7.3 2026-08-25. Desktop/web-launch; dcm4chee has a Weasis launch integration. |
| Stone Web Viewer (Orthanc) | orthanc.uclouvain.be | **AGPL-3.0** (licensing table) | Tied to Orthanc licensing; avoid. |

---

## 4. Toolkits, converters, terminology, synthetic data

| Name | Repo | License | Status / notes |
|---|---|---|---|
| pydicom | github.com/pydicom/pydicom | MIT (LICENSE text; GitHub shows NOASSERTION because of a GDCM-dictionary rider) | pushed 2026-10-22; 67 issues |
| pynetdicom | github.com/pydicom/pynetdicom | MIT | pushed 2026-10-11 |
| dcm4che toolkit | github.com/dcm4che/dcm4che | MPL-1.1/GPL-2+/LGPL-2.1+ tri-license (`LICENSE.txt` at root; text not fetched) | pushed 2026-10-20; 165 issues; `storescu` usable for synthetic load |
| microsoft/FHIR-Converter | github.com/microsoft/FHIR-Converter | MIT | HL7v2/C-CDA/JSON→FHIR, STU3→R4, FHIR→HL7v2 (preview); .NET + Liquid; MCR container image, default deploy = Azure Container Apps, templates in Azure Storage. Latest GitHub release tag v5.1.0 (2022-11-29) but repo pushed 2026-09-23 (3 commits/90d) — releases ship as container tags, not GitHub releases. |
| LinuxForHealth hl7v2-fhir-converter | github.com/LinuxForHealth/hl7v2-fhir-converter | Apache-2.0 | not archived; last push 2026-02-11; 32 issues — low activity |
| Snowstorm (SNOMED) | github.com/IHTSDO/snowstorm | Apache-2.0 per project README (**LICENSE file not retrievable via API; GitHub shows NOASSERTION — UNVERIFIED**) | 11.0.0 2026-09-02; 349 commits/90d; Elasticsearch-backed; SNOMED affiliate licence required for content |
| Hermes (SNOMED) | github.com/wardle/hermes | **EPL-2.0 (WC)** | v1.4.1629 2026-09-01; 0 open issues; single author |
| Ontoserver (CSIRO) | — | **C** | comparison only |
| HAPI FHIR terminology module | in hapi-fhir | Apache-2.0 | $validate-code/$expand/$lookup over JPA; loads SNOMED/LOINC |
| Synthea | github.com/synthetichealth/synthea | Apache-2.0 | 124 commits/90d; 280 issues; Java 17; FHIR R4 default (+STU3/DSTU2/CSV/C-CDA/CPCDS exporters). Throughput: one review measured 24 s per 100 patients (~15k/h, hardware unstated; arxiv.org/html/2411.04281v1); 1 M-patient SyntheticMass cohort published (JAMIA 2018, doi 10.1093/jamia/ocx079). No official patients/h benchmark — UNVERIFIED beyond those. No DICOM output. |
| Synthetic DICOM | — | — | Practical path: pydicom-generated pixel data + `storescu`/STOW; CTP/dcm4che have no generator. UNVERIFIED tools beyond this. |

### Test datasets
| Dataset | License | URL |
|---|---|---|
| TCIA | CC BY 3.0 or 4.0 per collection (commercial OK); a few legacy NC collections; DUA sets moved to NCI CRDC/dbGaP (Apr 2025) | cancerimagingarchive.net/data-usage-policies-and-restrictions/ |
| Medical Segmentation Decathlon | **CC BY-SA 4.0** (share-alike — do not mix into redistributed product fixtures) | medicaldecathlon.com; registry.opendata.aws/msd |
| NIH ChestX-ray14 | "usage unrestricted" + attribution/citation; no SPDX license; 112,120 images / 30,805 patients | nihcc.app.box.com/v/ChestXray-NIHCC |

---

## 5. De-identification

| Name | Repo | License | Notes |
|---|---|---|---|
| Presidio (moved to data-privacy-stack org) | github.com/data-privacy-stack/presidio (redirect from microsoft/presidio) | MIT | 2.2.364 2026-07-22; 11,466 stars; text/image PII; `presidio-image-redactor` has a DICOM redactor |
| Tools-for-Health-Data-Anonymization | github.com/microsoft/Tools-for-Health-Data-Anonymization | MIT | v4.2.2 2025-06-16; 62 commits/90d; .NET 8; FHIR + DICOM anonymizers, HIPAA Safe Harbor sample config; methods per docs/FHIR-anonymization.md (redact/dateShift/cryptoHash/encrypt/perturb/substitute/generalize — UNVERIFIED from README alone) |
| pydicom deid | github.com/pydicom/deid | MIT | pushed 2026-10-16 but last GitHub release 0.1.16 (2018) — releases go to PyPI |
| RSNA CTP | github.com/johnperry/CTP | **RSNA Public License (custom, non-OSI)** — UNVERIFIED terms (mirc.rsna.org/rsnapubliclicense.pdf) | last push 2025-10-31; Java |
| philter (UCSF) | github.com/BCHSI/philter-ucsf | BSD-3-Clause | last push 2024-08-20 — dormant |
| NLM Scrubber | binary only | NLM terms | not OSS |

---

## 6. Scored comparison (1–5, 5 best)

Criteria: L = license fit for a redistributable Azure product; Cf = published conformance; Sc = published scale;
H = horizontal scaling; Sh = shardable/partitionable storage; K = AKS/Helm readiness; G = Gov deployability & no
calls home on PG+Blob; Se = security posture; M = maintenance health.

| Engine | L | Cf | Sc | H | Sh | K | G | Se | M | **Total /45** |
|---|---|---|---|---|---|---|---|---|---|---|
| HAPI FHIR JPA | 5 | 4 | 4 | 4 | 3 | 5 | 5 | 3 | 5 | **38** |
| Medplum | 5 | 5 | 3 | 3 | 2 | 4 | 5 | 3 | 5 | **35** |
| Blaze | 5 | 2 | 5 | 3 | 2 | 2 | 1 | 3 | 4 | 27 |
| Microsoft fhir-server | 5 | 3 | 2 | 3 | 2 | 3 | 1 | 4 | 5 | 28 |
| LinuxForHealth FHIR | 5 | 2 | 2 | 3 | 2 | 3 | 4 | 2 | 1 | 24 |
| dcm4chee-arc-light | 4 | 4 | 3 | 3 | 2 | 2 | 5 | 2 | 4 | **29** |
| Orthanc | 1 | 3 | 3 | 3 | 2 | 3 | 3 | 2 | 4 | 24 |
| Microsoft dicom-server | 5 | 3 | 2 | 3 | 2 | 3 | 1 | 3 | 0 | 22 |
| Dicoogle | 1 | 2 | 1 | 2 | 1 | 2 | 3 | 2 | 2 | 16 |

Scoring notes: HAPI Sh=3 for Database Partition Mode (experimental) and partition-by-patient; Medplum Sh=2 because
Project isolation is logical only, one schema, no partition mode. dcm4chee Se=2 reflects a critical default-config
CVE batch three weeks old (fixed 5.35.2) — ship with AE registration and HL7 auth enforced in the Helm defaults.
dcm4chee K=2: no official Helm chart; WildFly + OpenLDAP + Keycloak must be chart-ified. Orthanc L=1: GPLv3 core +
AGPLv3 for PostgreSQL, DICOMweb and Azure-Blob plugins; the Azure plugin is paid-support-only maintenance.

---

## 7. Recommendation

### FHIR — primary: **HAPI FHIR JPA server (hapi-fhir-jpaserver-starter), Apache-2.0**
Why: Postgres-native with an official Helm chart and HPA; the only OSS engine with a documented path toward native
DB partitioning (Database Partition Mode) and patient-ID partitioning, so a Blob-tiered/partitioned Postgres can be
engineered without forking; best independent throughput of the Postgres OSS options (3,058 CRUD RPS, 2,214 res/s
import); the Inferno reference server is HAPI, so g(10) conformance is a packaging exercise (SMART authorizer +
bulk export) rather than engine work; validator + terminology are in-tree. No vendor telemetry; nothing Azure- or
Commercial-specific, so Gov parity is by construction.
Main risks: (1) **single JPA schema** — storage footprint ~3× competitors (22.6 GB per ~2 M resources), `HFJ_SPIDX_*`
bloat and autovacuum are the known failure mode; mitigate with Postgres Flexible read replicas for search, disabling
unused search params, Database Partition Mode from day one (no migration exists later), and a Blob-backed
`IBinaryStorageSvc` we must write. (2) True multi-DB sharding is Smile-commercial; our sharding must be ours
(partition → PG server routing at the ingress, which Database Partition Mode's PK design makes feasible). (3) No
auth built in — Entra/SMART authorizer is a required deliverable. (4) Dependency-CVE churn (Tomcat/Spring) — pin
and rebuild monthly.

### FHIR — fallback: **Medplum, Apache-2.0**
Why: ONC-certified (CHPL 2025-12-31) with SMART 2.0, OAuth server, subscriptions, bots and Azure Blob storage
already in-tree plus an Azure install path. Risks: Postgres-only with no partition mode (read replica is the only
scaling lever documented); ~half HAPI's throughput in the same test; no composite search; three High CVEs in 2026
(all patched — require ≥5.1.14); single-vendor roadmap; sample config ships vendor keys that must be replaced.

### DICOM — primary: **dcm4chee-arc-light 5.35.2+, tri-license (use under MPL-1.1 or LGPL-2.1)**
Why: PostgreSQL is its primary documented store; storage descriptors already target Azure Blob (jclouds
`azureblob`, endpoint overridable to `*.blob.core.usgovcloudapi.net`); complete DICOMweb incl. UPS-RS, full DIMSE,
HL7v2, IHE integration statement, conformance statements maintained per release; production references >1 M
studies; no telemetry; active (370 commits/90d, release 2026-10-15). OHIF (MIT) is the viewer.
Main risks: (1) **WildFly + OpenLDAP + Keycloak** footprint with no official Helm chart — we own the chart, LDAP
seeding and upgrade choreography; (2) single PG schema, no partitioning — scale by storage tiering (Blob
hot/cool/archive descriptors) and PG vertical/replica scaling, with multi-archive federation per tenant/region as
the sharding model; (3) critical default-config CVEs (Oct 2026) mean our chart must register AEs, authenticate HL7
and front DIMSE with a network policy; (4) effectively one core maintainer (J4Care) — mitigate by pinning releases
and keeping a vendored build.

### DICOM — fallback: **Orthanc 1.13.0 + PostgreSQL/DICOMweb/object-storage plugins — ONLY as an isolated, unmodified
GPL/AGPL service behind a network API, never linked**
Why: simplest engine, proven to 150 M instances / 65 TB, multi-writer PG since 1.9.2, Azure Blob plugin with client-
side encryption. Risks: AGPLv3 on every plugin we need, Azure plugin maintained only under paid support, two critical
CVEs in 20 months, no UPS-RS found, single maintainer. If licensing review rejects AGPL in the shipped product, the
real fallback is the archived **microsoft/dicom-server** (MIT) ported from SQL Server to Postgres — a substantial
port, listed here only because its Azure-shaped design (change feed, extended query tags, UPS) matches the target.

### Shared
Viewer: OHIF + Cornerstone3D (MIT). Converter: microsoft/FHIR-Converter (MIT) container. Terminology: Snowstorm
(verify LICENSE text before shipping) or HAPI's module. De-id: Tools-for-Health-Data-Anonymization (MIT) for
FHIR+DICOM, Presidio for free text. Synthetic: Synthea for FHIR; pydicom + `storescu` for DICOM load; TCIA CC-BY
collections for real-image fixtures (avoid MSD's CC-BY-SA in redistributed fixtures).
