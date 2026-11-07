# ADR-006 — Tenant-to-stamp routing and cross-stamp patient lookup (MPI)

Status: Proposed. Date: 2026-10-22.

## Routing
- Tenant resolution order: (1) URL prefix `/{tenantSlug}/fhir|dicomweb|terminology`,
  (2) token claim (`tid` + app role for Entra app tokens; `tenant` claim in
  LHDS-issued SMART tokens). Mismatch between (1) and (2) is a 403, audited.
- The routing map `{tenantSlug -> stampBaseUrl, status}` is published by the
  control plane to Azure API Management (classic Premium tier — in scope for
  IL5 in Gov; v2 tiers have no Gov regions, research) as a named value /
  policy fragment, with a 60 s cache and last-known-good on outage. Where APIM
  is not deployed (single-stamp pilots) the stamp ingress holds the same map.
- A draining tenant is routed to the source stamp for reads and writes until
  cutover (`../OPERATIONS-AND-BCDR.md` section 6); a paused stamp answers 503
  with `Retry-After` and reason.

## MPI (cross-stamp patient lookup)
- Store: control-plane PostgreSQL table `patient_identity` (id, tenant, stamp,
  identifiers[{system, value}], demographic hash, linkage group, source,
  updatedAt) fed by the outbox events for `Patient` create/update/merge.
- **Linking in v1 is deterministic**: identical enterprise identifier (VA ICN,
  IHS HRN, a tenant-declared enterprise system) => same linkage group; anything
  else is a *candidate* in a review queue, never auto-linked. Probabilistic
  matching (Fellegi-Sunter class, OpenEMPI-style) is **not** adopted without
  measured evidence on synthetic + partner data (Decision D11; W11+).
- Operations: `POST /mpi/$match` (demographics or identifiers -> linkage group
  + stamp pointers), `GET /mpi/Patient/{group}/$everything` (bounded fan-out,
  paged, audited once per stamp hit), `POST /mpi/$link` / `$unlink` (admin,
  audited, reversible).
- PHI minimisation: the MPI holds identifiers and hashed demographics; no
  clinical data. Access requires `user/Patient.rs` plus a `mpi` role.

## Options rejected
Routing by patient (would place one patient's data on many stamps and defeat
tenant isolation); a global FHIR server for `Patient` only (a second
clinical store); DNS-based routing (no claim verification).

## Consequences
Cross-tenant care (a veteran seen in two VISNs) works via MPI pointers and
explicit cross-tenant consent in the PDP, not via data replication.

## Reversal cost
Low (routing is configuration); MPI matching strategy is swappable because the
store keeps candidates and evidence.
