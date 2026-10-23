# ADR-011 — Consent and segmentation enforcement point (PDP)

Status: Proposed. Date: 2026-10-22. Sources: https://hl7.org/fhir/security-labels.html , https://hl7.org/fhir/consent.html , 42 CFR Part 2 (`../SECURITY-AND-COMPLIANCE.md` section 7).

## Decision
- One **PDP per stamp** (Deployment, 3+ replicas), implemented with **Open
  Policy Agent** (Apache-2.0) and Rego bundles versioned in the repo and
  distributed by the control plane (signed bundle, hash checked at load).
- Enforcement points: an HAPI interceptor (authorization + response filtering),
  a dcm4chee gateway filter (QIDO/WADO/STOW), the export and sink workers (bulk
  redaction), the MPI and viewer BFF.
- Inputs: token claims (scopes, subject, tenant, purpose of use), request
  (resource type, ids, compartment), resource labels (`meta.security`), the
  patient's active `Consent` resources (cached per patient with invalidation
  from the outbox), break-glass state.
- Outputs: permit / deny / permit-with-redaction (label set to strip) / obligations
  (add redisclosure header, emit BTG audit).
- Labeling service (W8): applies `meta.security` at write time from ValueSet
  membership rules and source tags; relabels on policy change via `$reindex`-
  style jobs.
- Alignment with Loom: the Loom access-policy model (`lib/azure/access-policy-client.ts`)
  governs Loom items and data-plane grants; LHDS policies are a separate bundle
  because they sit on the clinical read path with sub-10 ms budgets, but the
  admin UI presents both in one place (W9).

## Options rejected
Engine-native authorization only (no consent semantics); Loom's PDP inline
(latency, and it is not shaped for FHIR compartments); XACML servers (heavier,
less maintained OSS).

## Consequences
Policy is code with tests (the consent suite in `../TEST-STRATEGY.md` section
7); a PDP outage fails closed except for cached break-glass.

## Reversal cost
Low (OPA is replaceable behind the same decision API).
