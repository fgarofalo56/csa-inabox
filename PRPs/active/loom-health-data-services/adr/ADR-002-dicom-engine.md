# ADR-002 — DICOM engine: dcm4chee-arc-light (primary); fallback Orthanc (isolated) or a Loom DICOMweb-on-Blob service

Status: **Accepted: dcm4chee-arc-light on Azure Blob, with a Loom-owned
bearer-token refresher** (function proof, DEV 2026-10-23; W0-7 decision
2026-10-24 on the operator's Q2 ruling). If W3 cannot prove the refresher,
**Fallback B** (a Loom-built DICOMweb-on-Blob service) is taken, not Orthanc.
- Pass bars unmeasured, carried to W7: STOW p95 at 100 senders on class M.
- Carried to a W3 entry gate: the Blob descriptor against a Gov endpoint.
- Operator override via D2.

Date: 2026-10-22 (decision 2026-10-24). Evidence: `../research/oss-engine-evaluation.md`;
`../W0-RECEIPT.md` sections 3.3, 5.5 and 8.

Measured values: W0 DEV, dcm4chee-arc-light 5.35.2, jclouds 2.7.0, 1x D8s_v5
with the driver on the same node, PostgreSQL D2ds_v5, Commercial (centralus)
only. Function proof, not class-M pass-bar evidence.
- **STOW p95 at 100 senders: 1,041 ms against the 300 ms bar** (s3.3). The
  receipt says this is not a bar result (wrong profile, shared node, small
  database) and is not evidence that class M fails it either. It is
  **unmeasured** and goes to W7.
- Other saturation points on DEV (s3.3), to triage before the class-M run:
  - QIDO saturates between 100 and 150 senders, with JDBC pool exhaustion
    (`IJ000453`).
  - About 2,000 duplicate-key errors appear under concurrent STOW into the
    same study, while every STOW still returned 200.
- **Blob descriptor with CMK and a private endpoint: works** (s3.3). The
  `jclouds:azureblob` descriptor was accepted. CMK was on, and the private
  endpoint was the only path.
- **Blob descriptor against a Gov endpoint: not measured.** This becomes a W3
  entry gate (a GitHub Actions run).
- **Auth, the operability finding** (s3.3):
  - Shared key is refused by tenant policy, and jclouds 2.7.0 has no SAS mode.
  - jclouds shows no managed-identity flow (static evidence).
  - The only working mode was `azureAd` with a **static bearer token**: an
    89-minute lifetime and no refresh.
  - Decision per the Fallback text above: **a refresher sidecar/CronJob** that
    rewrites the descriptor's `credential` property before expiry. That keeps
    the storage-descriptor layer Loom-owned, as the Decision section already
    says, at a fraction of Fallback B's build cost.
  - A service-principal secret is rejected because it is a long-lived secret.
  - Orthanc is not the fallback: its Azure Blob plugin is under paid support,
    and the Q3 default is "AGPL no".
  - **Kill criterion for W3**: it is not established that the archive picks up
    a rewritten credential without a restart. The DEV runs restarted the
    archive after descriptor changes (s3.3 on the switch back to PVC, s5.5
    phase B), so hot pickup was never tested.
  - W3 must show at least two token expiries under STOW load with zero failed
    STOWs, and no restart or only a bounded reload. If it cannot, Fallback B
    is taken.
- **LDAP/WildFly as an AKS workload: met on DEV** (s3.3).
  - `slapcat` backup gave 1,595 entries and restored 1,595.
  - A StatefulSet restart had rootDSE answering in 12.2 s.
  - The first STOW returned 200 at 13.6 s with no manual step.
  - Caveat: the `restored != dumped` check was never mutation-tested.
- No-calls-home: dcm4chee and slapd made 0 non-Azure calls in a 30-minute idle
  window (s5.5). The 24 h capture is unmeasured.
- Licence (D2/Q3): not measured. Q3 is unanswered, so its default applies:
  "MPL/LGPL yes, AGPL no".

## Context
Imaging is the largest volume (~1 PB/yr stored for all VA, `../CAPACITY-MODEL.md`).
Need: full DICOMweb (STOW/QIDO/WADO-RS, UPS-RS), change feed, extended query
tags, export, Azure Blob pixel storage sharded per tenant, PostgreSQL metadata,
AKS, no calls home, a permissive or at least non-viral licence for a product
that is itself open source (this repo is public).

## Options
| Option | Licence | DB / storage | DICOMweb | Scale evidence | Health | Verdict |
|---|---|---|---|---|---|---|
| dcm4chee-arc-light 5.35.2+ | MPL-1.1 / GPL-2+ / LGPL-2.1+ tri-licence (use under MPL or LGPL) | PostgreSQL (primary documented); storage descriptors for filesystem, S3, Azure Blob via jclouds (`dcm4chee-arc-storage-cloud`) | Full incl. UPS-RS; DIMSE; HL7 v2; maintained DICOM/IHE conformance statements | Production references > 1 M studies | 370 commits/90 d; one core maintainer; CISA ICSMA-26-288-02 (2026-10-16): two CVSS 9.1 default-config flaws fixed in 5.35.2 | **Primary** |
| Orthanc 1.13 | GPLv3 core; PostgreSQL, DICOMweb and object-storage plugins AGPLv3; Azure Blob plugin under paid support | PostgreSQL multi-writer; Azure Blob plugin | Full | 150 M instances / 65 TB (cited) | active; CVE-2025-0896 (9.8), CVE-2026-87020 (8.1) | **Fallback A** — only as an unmodified network service (AGPL isolation), decision D2 |
| Microsoft dicom-server | MIT | SQL Server + Blob; server code moved to the `archived` branch, last release 2024-03-01, README states the team plans to archive | STOW/QIDO/WADO, change feed, extended tags, export, DICOMcast | AHDS lineage | wound down | **Fallback B as a design reference**: a Loom-built DICOMweb-on-Blob service (PostgreSQL metadata) modelled on its API shape |
| Dicoogle, Kheops | GPLv3 / unclear | — | partial | — | — | Rejected |

## Decision
dcm4chee-arc-light, used under its MPL/LGPL terms, unmodified where possible
(configuration, LDAP schema, storage descriptors, Helm chart Loom-owned), with
Loom in front: the PDP, per-tenant routing, the AHDS-shaped change-feed and
export endpoints, tenant-level Blob containers (one storage descriptor per
tenant), CMK, and the hardened defaults the CISA advisory requires (AE
registration enforced, HL7 authentication on, DIMSE disabled by default in v1
— DICOMweb only; DIMSE gateways are a per-tenant private-network option later).
WildFly + OpenLDAP + Keycloak: Keycloak is **replaced** by the LHDS
authorization server where dcm4chee's auth integration allows (OIDC), LDAP is
kept as dcm4chee's configuration store (single-replica StatefulSet with
backups, or the documented alternatives evaluated in W0).

## W0 pass bar (what would reverse this decision)
Any of: STOW p95 > 300 ms per 512 KB instance at 100 concurrent senders on a
class-M stamp; Azure Blob storage descriptor fails against a Gov endpoint
(`*.blob.core.usgovcloudapi.net`) or with CMK/private endpoints; LDAP/WildFly
cannot be run as a supportable AKS workload (no clean restart, no backup path);
a licence review (D2) rejects MPL/LGPL use for a public repo product.

## Consequences
- Loom owns a Helm chart and the operational knowledge of WildFly/LDAP.
- Single PostgreSQL schema per tenant (no partitioning in dcm4chee): tenants
  past ~20 B instances need a second archive instance (per-year sharding) —
  recorded in `../CAPACITY-MODEL.md` and D2.
- Security advisories must be tracked weekly (the 2026-10 advisory is the
  model of what we must catch).
- Fallback A brings AGPL plugins: acceptable only as an isolated service never
  linked or modified, with the obligation review in D2.

## Reversal cost
Medium-high for pixel data (Blob layout is engine-specific; a swap is a
re-import at ingest speed, ~months for a VA stamp); low for the API surface
(DICOMweb is the seam).
