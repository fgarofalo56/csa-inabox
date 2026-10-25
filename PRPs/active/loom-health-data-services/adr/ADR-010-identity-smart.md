# ADR-010 — Identity: Entra ID per cloud plus an LHDS Authorization Server for SMART on FHIR v2

Status: Proposed. Date: 2026-10-22. Sources: https://hl7.org/fhir/smart-app-launch/ (STU 2.2), https://learn.microsoft.com/en-us/azure/azure-government/documentation-government-plan-identity

## Context
SMART App Launch v2 requires: `.well-known/smart-configuration`, authorization
code + PKCE, granular scopes (`patient/Observation.rs?category=...`), launch
context (`launch/patient`, `fhirUser`), refresh tokens, Backend Services with
private-key JWT. Entra ID issues tokens for registered apps and scopes but
does not implement SMART launch context, granular SMART scope syntax, or
patient-context selection. AHDS solved this with Entra for identity plus a
SMART layer (the archived `fhir-proxy` / sample SMART authorizer, research).

## Decision
- **Entra ID is the only identity provider** (users, apps, managed identities)
  per cloud; no local accounts.
- **LHDS Authorization Server** (control plane, W1): an OAuth 2.1 / OIDC server
  that federates to Entra for authentication (OIDC), applies the tenant's
  scope policy (Entra group/app role -> allowed SMART scopes), handles launch
  context (standalone patient picker, EHR launch via a Loom item editor),
  issues SMART access tokens (short-lived, audience = tenant FHIR base) and
  refresh tokens, serves `smart-configuration`, and implements Backend Services
  client registration with JWKS. Implementation candidates evaluated in W1:
  an OSS OAuth server embedded in the control plane (e.g. `node-oidc-provider`,
  MIT) versus Medplum's authorizer extracted (Apache-2.0); the decision is
  recorded in W1's receipt.
- Engines validate the LHDS token (JWKS) via the PDP interceptor; they never
  talk to Entra.
- Entra Government endpoints (`login.microsoftonline.us`) resolved through the
  existing `cloud-endpoints.ts`.
- Patient-facing access (patient apps) uses Entra External ID where available
  per cloud (research row "Entra"); otherwise tenant-issued patient accounts in
  Entra B2B — Decision D13.

## Implementation choice (W1-4 design pass, 2026-10-25; not yet confirmed)
Selected candidate: `node-oidc-provider` (MIT) embedded in `apps/loom-health-cp`.
Fallback 1: Medplum authorizer extracted (Apache-2.0). Fallback 2: a minimal
authorizer on `jose`. None of these libraries' code or docs was read for this
pass, so their fitness is UNVERIFIED. The choice is confirmed only by the W1-4
implementation receipt meeting **all four** points of this pass bar:

1. The Inferno SMART App Launch STU2 kit has zero failures (standalone and EHR
   launch).
2. Negative-scope matrix rows N1-N23 run, with mutation arms (i)-(iii)
   red-then-green.
3. Token signing uses non-exportable, HSM-backed Key Vault keys, unless the
   operator decides otherwise (Q1).
4. Per-cloud authority and Graph hosts are unit-tested, and the GCC-High
   receipt comes from Actions.

If point 1 or 3 is still unmet after three implementation sessions, the work
moves to Fallback 1. The full design is in `docs/fiab/health/security.md`
section A: the scope grammar, launch contexts, the role-to-scope table
(canonical data in `apps/loom-health-cp/src/auth/role-scope-map.v1.json`), the
per-cloud Entra mapping, Backend Services JWKS, the access-token claims
contract (`lhds-at/1`) the PDP consumes, the tenant-match rule, the test
matrix, and the open questions.

## Consequences
One more service in the control plane with a strict security review
(`review: required`); SMART conformance tested by Inferno.

## Reversal cost
Low-medium: tokens are standard JWTs; another authorizer can be swapped in
behind the same discovery document.
