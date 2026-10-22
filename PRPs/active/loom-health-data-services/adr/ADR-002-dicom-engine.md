# ADR-002 — DICOM engine: dcm4chee-arc-light (primary); fallback Orthanc (isolated) or a Loom DICOMweb-on-Blob service

Status: **Proposed** (fixed by the W0 receipt; operator override via D2).
Date: 2026-10-22. Evidence: `../research/oss-engine-evaluation.md`.

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
