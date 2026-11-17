# loom-health-dicom-gateway

DICOMweb gateway for CSA Loom Health Data Services (LHDS W3-3). The only path to a
tenant's dcm4chee archive (`apps/loom-health-dicom`, whose DICOMweb is the unauthenticated
upstream WAR). Authorizes every request through the PDP, audits every interaction,
streams STOW and WADO. Holds no clinical data. Azure-native, no Fabric dependency.

**Pod label contract.** Gateway pods MUST carry `app.kubernetes.io/name: loom-health-dicom-gateway`.
The archive's NetworkPolicy admits only that label on port 8080. The workload bicep
(not part of this PR) must set it.

## Surface

`/{tenant}/dicomweb/v1/...` (the PDP `base` is `<LOOM_DICOM_GW_PUBLIC_BASE>/<tenant>/dicomweb`).

| Interaction (PDP) | Routes |
|---|---|
| `qido` | `GET /studies`, `/series`, `/instances`, `/studies/{s}/series`, `/studies/{s}/instances`, `/studies/{s}/series/{r}/instances` |
| `wado` | `GET\|HEAD` study, series, instance, each `/metadata`, `/rendered`, `/thumbnail`; `.../frames/{n[,n]}[/rendered]` |
| `stow` | `POST /studies`, `POST /studies/{s}` (multipart/related, streamed, cap 4 GiB) |

Anything else is 404 before authentication: the route grammar is an allowlist, so no other
archive endpoint is reachable. QIDO: `limit` 1-200 (default 100), `offset` >= 0, else 400.

## Request pipeline

1. Route parse (UID grammar, encoded separators rejected, tenant slug).
2. No `Authorization: Bearer` -> 401. The raw token goes to the PDP, never to the archive.
3. PDP `POST /v1/data/lhds/authz/decision` with `{service: dicom, interaction, tenant (route), base (config)}`.
   Only `result.allow === true` permits; a timeout, 5xx, `{}`, non-boolean or exception is **503** (fail closed).
   Deny: 401 for credential reasons (`token-invalid`, `claims-invalid`, `token-time-invalid`, ...), else 403.
4. Decision audit record written; if the sink throws, 503 and no data flows.
5. Proxy to the route tenant's archive only (`LOOM_DICOM_GW_ARCHIVE_URL_TEMPLATE`, `{tenant}` slug-checked).
   QIDO/STOW bodies (<= 16 MiB) have the archive `RetrieveURL` prefix rewritten to the public gateway URL.
6. Completion audit record (status, bytes). No query values and no token are ever audited.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `LOOM_DICOM_GW_PDP_URL` | required | in-cluster OPA base URL |
| `LOOM_DICOM_GW_PUBLIC_BASE` | required | stamp base URL; never derived from the Host header |
| `LOOM_DICOM_GW_ARCHIVE_URL_TEMPLATE` | required | must contain `{tenant}` |
| `LOOM_DICOM_GW_ARCHIVE_AET` | `DCM4CHEE` | archive AE title in `/dcm4chee-arc/aets/{AET}/rs` |
| `LOOM_DICOM_GW_PDP_TIMEOUT_MS` | 2000 | PDP deadline |
| `LOOM_DICOM_GW_STOW_MAX_BYTES` | 4 GiB | hard cap on received bytes |
| `LOOM_DICOM_GW_ARCHIVE_TIMEOUT_MS` | 120000 | idle timeout to the archive |
| `LOOM_DICOM_GW_PORT` | 8080 | listen port |

## Not here (W03b / later), so not claimed

Change feed, extended query tags, partitions, soft delete + purge (`delete` interaction), UPS-RS,
Valkey cache (ADR-004; deliberately absent: a QIDO page cache must be keyed by the authorization
decision and has no W3-3 acceptance row), transfer-syntax negotiation assertions (archive-side),
archive rehydration 202. The PDP's DICOM fields `patient_compartment` / `categories` are NOT sent:
the DICOM rules are role-only in bundle v1.

## Test

```
npm ci && npm test                       # 74 tests, stubbed archive + stubbed PDP
LOOM_DICOM_GW_BIG_STOW=1 npm test        # the full 2 GiB streaming STOW
```

Not verified: anything on a live stamp (no DICOM stamp is deployed), GCC-High.
