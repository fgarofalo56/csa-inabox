# ADR-004 — DICOM pixel data in Blob, metadata in PostgreSQL, DICOMweb front-end scaling and caching

Status: **Accepted: pixel data in Azure Blob with CMK and private endpoint,
metadata in PostgreSQL** (function proof, DEV 2026-10-23, Commercial only;
W0-7 decision 2026-10-24 on the operator's Q2 ruling).
- Carried to a W3 entry gate: the descriptor against a Gov Blob endpoint.
- Unmeasured, carried to W7: Blob 503 onset and request rate at class M, and
  the multi-account tenant-year sharding.
- Pixel-path auth follows ADR-002: a bearer-token refresher, with Fallback B
  if W3 cannot prove it.

Measured values: W0 DEV, `../W0-RECEIPT.md` section 3.3, Commercial
(centralus). Function proof, not class-M pass-bar evidence.
- **Blob, CMK and private endpoint work end to end.**
  - `encryption.keySource=Microsoft.Keyvault` against a Key Vault with public
    access disabled.
  - `publicNetworkAccess=Disabled`, with the private endpoint as the only
    path.
  - STOW and WADO returned 200 at every load step.
- **No HTTP 503 up to 400 requested senders**: 7,750 of 7,750 direct 512 KiB
  PUTs returned 201. Achieved concurrency was not measured, so the onset at
  class M is unmeasured and goes to W7.
- **Auth constraint**:
  - Shared key is policy-disabled in a regulated-shaped tenant.
  - jclouds 2.7.0 shows no managed-identity flow.
  - The descriptor works only with a static Entra bearer token: 89 minutes, no
    refresh.
  - Decision: see ADR-002 (refresher, else Fallback B).
- **LDAP dumps carry the descriptor `credential` in clear text** (s3.3). Under
  the refresher this is a short-lived bearer token, not a storage key. Dumps
  stay out of the repo, and LDAP admin is a privileged role (W3 input).
- **Not measured**:
  - The Gov endpoint (`*.blob.core.usgovcloudapi.net`), a W3 entry gate run
    through Actions.
  - Flat namespace versus HNS on the DEV account.
  - Per-tenant-year descriptor rotation.
  - Object replication.
  - Valkey caching.
  - Archive rehydration.

Date: 2026-10-22 (decision 2026-10-24). Evidence: `../research/scale-evidence-va-ihs-dicom-pricing.md` (Blob limits, prices), `../research/oss-engine-evaluation.md` (dcm4chee storage descriptors), `../research/terminology-conformance-ops-facts.md` section C (immutability, object replication, HNS limitation).

## Decision
- **Pixel data**: Azure Blob Storage, **flat namespace** (not ADLS Gen2 HNS, so
  object replication and version-level immutability are available), one
  container per tenant, blob path `{tenant}/{yyyy}/{studyUid}/{seriesUid}/{sopUid}`,
  stored in the received transfer syntax (no transcoding on ingest in v1;
  lossless HTJ2K/JPEG 2000 transcoding as a lifecycle job is D16), CMK per
  tenant, versioning on, soft delete 30 days, lifecycle hot -> cool -> archive
  per tenant policy, optional time-based immutability per tenant (legal
  retention).
- **Sharding**: a tenant gets a new storage account per year once an account
  passes 2 PiB or 50 % of its request-rate limit (5 PiB / 40 k req/s in US Gov
  Virginia, cited); dcm4chee storage descriptors are per tenant-year with the
  active descriptor for writes and all descriptors for reads.
- **Metadata**: dcm4chee schema in the tenant's PostgreSQL database
  (patient/study/series/instance tables, extended query tags), plus an LHDS
  `dicom_change_feed` and `dicom_content_hash` table (SHA-256 per instance at
  STOW, verified on export and on the quarterly integrity sample).
- **Front end**: DICOMweb pods stateless; large multipart STOW streamed to Blob
  (no full buffering: memory assertion in `../TEST-STRATEGY.md` section 3);
  WADO frames served by streaming from Blob through the engine (clients never
  receive SAS URLs: the PDP and audit stay in the path). Cache: an in-cluster
  Valkey (BSD-3) for QIDO result pages and metadata (`/metadata`) with short
  TTLs keyed by tenant; frame-level caching only in the viewer BFF
  (`Cache-Control: no-store` to the browser). Azure Cache for Redis is not used
  because the managed service stops accepting new caches in 2026-04 and Azure
  Managed Redis has no Gov audit row (research).
- **Archive rehydration**: a WADO for an archived instance returns 202 with
  the rehydration estimate and triggers rehydration; the viewer renders the
  state honestly (`../OPERATIONS-AND-BCDR.md` section 9).
- **DR**: object replication to the alternate region per tenant policy
  (`../OPERATIONS-AND-BCDR.md` section 5) — requires flat namespace (hence the
  first bullet).

## Options rejected
ADLS Gen2 HNS for pixel data (no object replication, no version-level WORM —
research); storing pixel data inside PostgreSQL (size); per-study single
blobs (frame-level WADO would need range reads inside an opaque file).

## Consequences
Per-tenant accounts mean many accounts at VA scale (tens to hundreds) — the
control plane owns their lifecycle via bicep; monitoring is per account.

## Reversal cost
High (a re-layout is a copy of the whole archive); hence W0 validates the Blob
descriptor against Gov endpoints and CMK before W3 begins.
