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
- The allow-list is applied to EVERY archive AE under the device (`dicomAETitle=*`, e.g. `DCM4CHEE_ADMIN`, `IOCM_*`),
  and every write is read back (a failed `ldapsearch` fails the init container; `cn=dicom`, `cn=dicom-tls` and HL7
  are all read).
- The chart refuses `aeEnforce` other than true unless `allowUnenforced=true` (compared as a string, so a quoted
  "false" is refused too), and refuses `dimseEnabled=true` unless `allowDimse=true`.
- **NetworkPolicy** (default-deny ingress): archive pods accept 8080 only from pods labelled
  `networkPolicy.gatewayPodLabels` (default `app.kubernetes.io/name: loom-health-dicom-gateway`, same namespace: the
  W3-3 gateway). 2575 (HL7) is denied to everyone unless `networkPolicy.hl7Enabled=true` (then gateway-only); 11112
  is opened (gateway-only) only with DIMSE on. The LDAP store accepts 389 from the archive pod only. Egress is not
  restricted. Requires a CNI that enforces NetworkPolicy.

## Patched jars

Upstream 5.35.2 ships netty-handler 4.1.136 (CVE-2026-75595) and bcprov 1.84 (CVE-2026-8763). The Dockerfile
swaps in netty-handler 4.1.137.Final and bcprov 1.85 (sha256-verified at build) and rewrites the WildFly
`module.xml` resource-root names. `bin/client/jboss-client.jar`, which shades the old netty and is not loaded by
the server, is removed. netty-handler is now one patch release ahead of its sibling netty modules (4.1.136);
patch releases are binary compatible and the live run boots and serves with this mix.

## Not covered here

- DICOMweb itself is unauthenticated (the upstream `unsecure` WAR): it is reachable only through the Loom
  gateway (W3-3) via the NetworkPolicy above. Not verified on a live cluster: enforcement depends on the CNI.
- Hostname validation of calling AEs/HL7 senders is not set: pod IPs are dynamic.
- Cosign signing and Trivy gating are CI steps; Blob storage and the token refresher are W3-2.
- GCC-High / IL5: supported-in-code only, never exercised (`cloud-parity.md`).
