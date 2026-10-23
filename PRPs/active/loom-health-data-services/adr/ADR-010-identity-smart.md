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

## Consequences
One more service in the control plane with a strict security review
(`review: required`); SMART conformance tested by Inferno.

## Reversal cost
Low-medium: tokens are standard JWTs; another authorizer can be swapped in
behind the same discovery document.
