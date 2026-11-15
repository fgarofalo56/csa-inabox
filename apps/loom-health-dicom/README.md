# loom-health-dicom

dcm4chee-arc-light 5.35.2 (ADR-002) with Loom's hardened defaults, plus the Helm chart that runs it
per tenant. LHDS W3-1. Not deployed by this directory alone: the ACR matrix row is a separate
integration PR, and the Blob storage descriptor is W3-2.

| Piece | What it is |
|---|---|
| `Dockerfile` | Thin layer on `dcm4che/dcm4chee-arc-psql`, pinned by digest. Carries no hardening. |
| `ldap/Dockerfile`, `ldap/harden.sh` | The `slapd-dcm4chee` config store (digest-pinned) plus the script that applies the defaults to it. |
| `chart/` | Renders LDAP StatefulSet, archive Deployment, Services. The archive pod has a `harden` initContainer, so the archive never boots on the image's accept-anything defaults. |
| `scripts/verify-image.sh` | Live acceptance on a private docker network (below). |
| `tests/` | Static + stub-driven contract; `node --test apps/loom-health-dicom/tests/`. |

## Hardened defaults

Hardening lives in the LDAP configuration store, not the image, because that is where dcm4chee keeps it.

- **AE registration enforced** (`AE_ENFORCE=true`): `dcmAcceptedCallingAETitle` lists the registered
  calling AEs (default `LOOMGW`); any other calling AE gets A-ASSOCIATE-RJ. The image default is "any if absent".
  DICOMweb addresses the archive's own AE title in the URL, so an unregistered title there is 404 in dcm4chee
  regardless of this flag. The flag governs DIMSE calling AEs.
- **HL7 auth on** (`HL7_AUTH=true`): `hl7AcceptedSendingApplication` replaces the accept-any wildcard sender.
- **DIMSE listener off** (`DIMSE_ENABLED=false`): the DICOM connections get no `dicomPort`, so nothing binds 11112.
  The chart exposes 11112 only when `hardening.dimseEnabled=true`.
- The chart refuses `aeEnforce=false` unless `allowUnenforced=true`.

## Not covered here

- DICOMweb itself is unauthenticated (the upstream `unsecure` WAR): it must only be reachable through the Loom
  gateway (W3-3) and a NetworkPolicy. Neither exists yet.
- Hostname validation of calling AEs/HL7 senders is not set: pod IPs are dynamic.
- Cosign signing and Trivy gating are CI steps; Blob storage and the token refresher are W3-2.
- GCC-High / IL5: supported-in-code only, never exercised (`cloud-parity.md`).
