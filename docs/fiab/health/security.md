# Loom Health Data Services: security

> **Status: A1-A11 are the design; A12 records the W1-4 server code. Merged
> is not deployed.** This page currently holds only the **authorization
> section** (PRP item W1-4). The Authorization Server code lives in
> `apps/loom-health-cp/src/auth/`. It is **wired** (`main.ts` builds it from
> `wire.ts`; `compose.ts` mounts it in front of the control-plane app) and
> **deployed on Commercial dev01**:
> - The issuer has been served through Front Door on `/auth/*` since #5413.
> - Key Vault token minting was verified live (deploy-health 44947837477).
> - The W1b-3a discovery and CORS changes were verified live on 2026-11-24 (#5461).
>
> Not exercised live: an interactive Entra authorization-code sign-in, the
> Graph membership check, and anything in GCC-High (#5123). A12 lists what
> was and was not measured. The rest of this page (network,
> keys, audit, evidence pack) belongs to W1-9 and later waves. Mapping only, no ATO, FedRAMP or HIPAA-compliance claim
> (`PRPs/active/loom-health-data-services/SECURITY-AND-COMPLIANCE.md:3-10`).

Paths below are repo-relative. `PRP/` is shorthand for
`PRPs/active/loom-health-data-services/`. Every repo claim cites `file:line` at
`origin/main` `be5f24fc2`. Sources read in full: `PRP/W01-control-plane-identity-stamp.md`,
`PRP/ARCHITECTURE.md`, `PRP/SECURITY-AND-COMPLIANCE.md`, `PRP/LOOM-INTEGRATION.md`,
`PRP/OPERATOR-DECISIONS-2026-10-22.md`, ADR-005, 006, 009, 010, 011 and 012, and
`apps/loom-health-cp/{README.md,package.json,src/config.ts,src/middleware/auth.ts,src/http/app.ts,src/registry/types.ts}`.
Read only in part, so claims from them are limited to the cited lines:
`PRP/TEST-STRATEGY.md` (lines 25-159), `PRP/AHDS-MODEL-MAP.md` (20-64),
`PRP/RISKS-AND-OPEN-DECISIONS.md` (lines 21-24 only),
`PRP/AZURE-GOV-AVAILABILITY.md` (line 45 only),
`apps/fiab-console/lib/azure/cloud-endpoints.ts` (480-510). Anything about
third-party code (node-oidc-provider, Medplum) is **UNVERIFIED**: none of it
was read for this pass.

External normative sources, all read for this pass: SMART App Launch STU 2.2
([scopes and launch context](https://hl7.org/fhir/smart-app-launch/scopes-and-launch-context.html),
[conformance](https://hl7.org/fhir/smart-app-launch/conformance.html),
[backend services](https://hl7.org/fhir/smart-app-launch/backend-services.html),
[asymmetric client auth](https://hl7.org/fhir/smart-app-launch/client-confidential-asymmetric.html)).

## A. Authorization: SMART App Launch v2 over Entra ID (W1-4)

### A1. What exists today and what this section decides

- **Already there:** the control plane's own admin API verifies **Entra**
  tokens: RS256, issuer pinned to one Entra tenant, audience list, `exp`
  required (`apps/loom-health-cp/src/middleware/auth.ts:45-60`). It also
  checks the app roles `HealthCP.Reader/Admin/StampReporter`
  (`auth.ts:13-23,70`). That guards the control plane. It is **not** the SMART
  authorization server, and those roles never become FHIR scopes.
- **Decided by ADR-010:** Entra is the only identity provider. The LHDS
  Authorization Server (AS) federates to Entra over OIDC, maps Entra
  group/app-role membership to SMART scopes, handles launch context, mints
  short-lived SMART tokens whose audience is the tenant FHIR base, and serves
  `smart-configuration` and Backend Services with JWKS. Engines validate the
  LHDS token through the PDP and never talk to Entra
  (`PRP/adr/ADR-010-identity-smart.md:15-28`).
- **Decided here:** the scope grammar subset LHDS accepts (A2), launch
  contexts (A3), the role-to-scope table and its intersection rule (A4), the
  per-cloud Entra mapping (A5), the Backend Services JWKS flow (A6), the
  **access-token claims contract the PDP consumes** (A7), the tenant-match rule
  (A8), the negative-scope test matrix (A9), and the ADR-010 implementation
  choice with its pass bar and fallback (A10).

**Endpoints.** This design adds no route that the PRP and the SMART spec do
not already require. SMART requires a `token_endpoint` and, for launch flows,
an `authorization_endpoint`. It also requires the discovery document at
`{fhirBase}/.well-known/smart-configuration`, which ADR-010:22 names. Their
concrete paths are an implementation detail recorded in that discovery
document. No revocation, management or dynamic-registration endpoint is
designed or advertised. Client registration has no surface in the PRP yet; see
open question Q4.

**Token introspection (#5151, operator decision 2026-11-28; merged, not
deployed).** `POST {issuer}/{tenant}/introspect` (RFC 7662) is advertised as
`introspection_endpoint` in that tenant's `smart-configuration` and
`openid-configuration`. It is never anonymous: the caller must be an active
**backend** client of the same tenant that an admin granted `introspect: true`
(client registration or `PATCH /api/health/auth/clients/{id}`; never a scope,
never an app client). It authenticates with exactly one of a Bearer access
token the AS issued it by `client_credentials` (the SMART STU2.2 form) or a
`private_key_jwt` assertion whose `aud` is the introspection URL; anything else
is `401 invalid_client`. An access token or refresh token that is not active
on the path tenant, for a client still active there, reads `{"active":false}`
and nothing else. An active token returns `scope`, `client_id`, `exp`, `iat`,
`sub`, `aud`, `iss` (the tenant OpenID issuer, equal to the id_token `iss`),
`tenant`, `token_type` (access tokens), and `patient` / `encounter` /
`fhirUser` when the token carries them. Known gaps: an access token's `scope`
is its v2 form, so a client that asked in v1 syntax sees different strings
from its token response; `need_patient_banner` and `fhirContext` are not in
the access token, so they are not returned.

Every introspection call emits one `auth.introspect` log event carrying
`tenant`, `caller` (the authenticated client id, or `-` when refused),
`outcome` (`active` / `inactive` / `refused` / `error`), `active` (1/0) and,
only for an active token, `tokenClientId`. It never carries the token, a hash
of it, or any `patient` / `fhirUser` value. The CORS preflight is not answered
on this path, so a browser is never told it may send an `Authorization`
header. The client id `lhds-patient-picker` is reserved at registration,
because the picker's 60 s user tokens carry it.

**Accepted risk (#5515 review).** ANY `client_credentials` access token of a
flagged client is accepted as the caller credential, including one it also
sends to the FHIR server. Whoever obtains that token (a FHIR-side log, a
compromised proxy) can therefore introspect this tenant's tokens for up to the
token's 300 s lifetime. Mitigations not taken yet: a dedicated introspection
scope that the bearer must carry, or an introspection token whose `aud` is the
introspection URL rather than the FHIR base. A follow-up issue tracks the
choice.

**Key rotation.** Introspection verifies against the AS's current ES384 key
only. After a restart that picks up a rotated key, access tokens signed with
the previous key read `{"active":false}` until they expire (at most 300 s).
The PDP's view of the same tokens is governed separately. Refresh tokens are
unaffected because they are looked up by hash. A refresh token's `iat` is its
stored issue time; documents written before #5151 fall back to
`exp - 30 days`.

**Implemented discovery and protocol details (W1b-3a A1/A2, #5454; merged, not
deployed).** The control plane serves `smart-configuration` both under the
issuer path and at `/{tenant}/fhir/.well-known/smart-configuration`, the path a
FHIR edge forwards to the issuer (the edge router, G1, is in code and not yet
deployed; see "FHIR edge router").
id_tokens use a per-tenant OpenID issuer, `{issuer}/{tenant}`, whose document
is `{issuer}/{tenant}/.well-known/openid-configuration`; `smart-configuration`
names the same issuer. Access tokens keep the tenant-independent issuer that
the PDP and the APIM `validate-jwt` pin, and the tenant-independent
`{issuer}/.well-known/openid-configuration` is unchanged. `none` is advertised
beside `private_key_jwt`. On the code and refresh grants a confidential client
may omit `client_id` and is identified by its verified assertion `iss`
(RFC 7523 section 3). A public client must send `client_id`, and a `client_id`
that differs from the assertion `iss` is `invalid_client`. Discovery and JWKS
responses carry `Access-Control-Allow-Origin: *`. The token endpoint sends it
only to public clients. No response allows credentials. A launch
`fhirContext` takes STU2.2 objects (a bare string becomes `{reference}`), and
the token response carries it. An `identifier.system` in it, when present,
must be non-empty.

**fhirUser, launchUri and token-endpoint CORS (W1b-3a A3/A4, #5454; merged, not
deployed).** `fhirUser` now comes from an operator-managed mapping, one per
(tenant, Entra `oid`), held in `health-auth-config` as a `kind: fhiruser`
document with id `fhiruser-{tenant}-{oid}`. It holds a relative reference to a
`Practitioner`, `Patient`, `RelatedPerson` or `Person`. Sign-in turns it into
the absolute URL `{tenant FHIR base}/{reference}`, and that same value goes
into the id_token `fhirUser` claim and the access-token `fhirUser` claim. The
mapping is read only when the app requests the `fhirUser` scope. With no
mapping the scope is not granted and neither token carries the claim (Q5 is
answered by explicit mapping, not identifier matching). If the mapping store
fails, the sign-in **fails closed**: the app gets an OAuth `server_error`
redirect with no code, and the CP logs `auth.fhir_user_error`. Dropping the
scope silently would hand out a session that had lost `fhirUser` without
saying so. An app client may carry a `launchUri`, its EHR-launch URL. It is
validated like a `redirect_uri` (https or loopback http, no credentials, no
fragment) and refused on a backend client. The token endpoint also sends
`Access-Control-Allow-Origin: *` on any response to a request with **no**
`client_assertion`, so a browser app can read an `invalid_client` raised
before its client resolves (an unknown `client_id`). Such a request can only
ever earn a token as a public client. A request that carries a
`client_assertion` gets the header only once it resolves to a public client
(a public client whose assertion `iss` equals its `client_id`; the assertion is
then ignored). A confidential client's response, token or error, never
carries it. Since #5461, a public client that sends `client_id` together with a
`client_assertion` that is not a JWT receives `invalid_client`, because the
assertion `iss` cannot match the `client_id`.

**RS256 id_tokens (W1b-3a A7, #5454; merged, not deployed).** id_tokens are
signed **RS256**; access tokens stay **ES384** (A7 below is unchanged). The
id_token key is an `RSA-HSM` 3072-bit key named `lhds-as-idtoken-rs256`
(key_ops sign and verify, non-exportable), in the same stamp vault as the
ES384 access-token key. No bicep creates it and no new environment variable
names it: the control plane derives the vault from
`LOOM_HEALTH_CP_SIGNING_KEY_ID` and, on first use, GETs the key and creates it
on a 404. Its `Key Vault Crypto Officer` assignment on the stamp vault
(`control-plane.bicep`) covers the create. Signing goes through the Key Vault
`sign` operation (`alg: RS256`, a SHA-256 digest of the signing input) on a
versioned key URL. The private key never enters the process. `jwks.json`
publishes both keys: the EC P-384 key (`alg: ES384`) and every enabled
version of the RSA key (`alg: RS256`). Each has an RFC 7638 thumbprint as its
`kid`, `use: sig`, and public members only. Normally that is one RSA key. Two
replicas can race the first create. Each then waits 3 s, lists the versions and
signs with the oldest enabled one, and the JWKS publishes all of them, so the
kid of an issued id_token is in the JWKS of either replica. The per-tenant
`openid-configuration` lists `id_token_signing_alg_values_supported:
["RS256"]`. If the key cannot be read or created (for example, Key Vault
answers 403), a token request that asks for `openid` fails with
`server_error`. The log line `auth.internal_error` then carries `step:
id_token` and the Key Vault status. There is no ES384 id_token fallback.
`jwks.json` keeps serving the EC key and logs `auth.idtoken_key_unavailable`.
A failed read is never cached. Rotating the key means adding a version,
disabling the old one, and restarting the control plane.

**Standalone patient picker (W1b-3a A5, #5454; merged, not deployed).** When
an app asks for `launch/patient` without an EHR launch handle, and a patient
context would leave the user at least one `patient/` scope (their role
ceilings and the client's allowed scopes both include one), the Entra callback
issues **no code**. It stores a single-use `pick` document in
`health-auth-grants` (600 s TTL) holding everything needed to issue the code
later. It then sets a new `lhds_pk_{pick}` cookie (HttpOnly, SameSite=Lax,
Secure on an https issuer, `Path={issuer path}/{tenant}/pick`; only its
SHA-256 is stored) and redirects to `{issuer}/{tenant}/pick?req={pick}`. The
page is server-rendered HTML with no JavaScript and no external assets. Every
value in it is HTML-escaped, and it is sent with
`content-security-policy: default-src 'none'; style-src 'unsafe-inline';
form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
`x-frame-options: DENY`, `cache-control: no-store` and
`referrer-policy: no-referrer`. `GET` on the picker renders only the empty
search form and ignores any `q` or `birthdate` in the URL. The search itself is
a form `POST` (`action=search`, with `q` and an optional `birthdate`).
A patient name and birth date are PHI, and a query string lands in the
Front Door and App Gateway access logs; a POST body does not. A search POST
passes the same pick, cookie and CSRF checks as a selection and re-renders
with a fresh CSRF value. The search runs server-side as the user. Group
membership is re-read through Graph on every request, as the refresh grant
does. The AS calls `{tenant FHIR base}/Patient?name=…&_count=20` (server to
FHIR, not through the browser) with a token it mints for that user:
`sub_type` `user`, 60 s, `client_id` `lhds-patient-picker`, `idp_tid` = the
user's own Entra tenant from sign-in, scope `user/Patient.rs` intersected with
the user's role ceilings. A user whose roles
no longer allow that scope sees a "not permitted" state with no search box and
two buttons: Cancel, and **Continue without a patient** (operator decision on
#5464). Continue is a `POST` with `action=continue` and passes the same pick,
cookie and CSRF checks. It consumes the pick and issues the code exactly as the
pre-picker flow did: the grant is recomputed with fresh roles and no patient.
Every `patient/` scope is dropped, the other scopes (`openid`, `fhirUser`,
`user/`, `offline_access`) are kept, and an empty result redirects
`invalid_scope`. Continue is offered only in that state. A forged continue
from a user who may search issues nothing and returns them to the picker. The
choice is a form `POST` carrying a CSRF value that is rotated on every render,
with only its hash stored. The AS checks that the pick exists, is unused, is
unexpired and belongs to this tenant. It also checks the cookie, compares the
CSRF value timing-safely, and confirms with `GET Patient/{id}` that this user
can read the chosen patient. Only then does it consume the pick
(etag-guarded) and issue a code. The grant is recomputed with the patient, so
`patient/` scopes survive, and the token response carries `patient` and
`need_patient_banner: true`. Cancel returns `error=access_denied` with the
app's `state`. When `launch/patient` would grant no `patient/` scope, the
picker is skipped and the code is issued as before. An EHR launch never shows
it. Patient ids made only of dots (`.`, `..`) are refused wherever an id builds
a URL: the fhirUser mapping, the launch `patient` and the picked patient.

**Honest limit: the live search needs the FHIR edge.** The picker calls the
tenant FHIR base the token audience names, and that edge is not deployed yet
(W1b-3a spec, G1: the router is in code, see "FHIR edge router"). Until it is
deployed and verified, every search ends in the
"Patient search is unavailable: the tenant FHIR endpoint did not respond"
state (HTTP 503, Cancel only). The AS never fabricates a patient. The flow is
tested only against a fake `PatientSearch` and a fake `fetch`; no live receipt
exists for any boundary.

**EHR launcher and admin patient search (W1b-3a A6, #5454; merged, not
deployed).** The health-tenant editor's **Apps** tab lists, registers,
enables/disables and launches the tenant's SMART app clients through the
control-plane admin routes. Launch calls `POST /api/health/auth/launch` with
the signed-in console user's `oid` taken from the console session (never a
request body) and sends the browser to
`launchUri?iss=<tenant FHIR base>&launch=<handle>`. The FHIR base is the `iss`
the launch route now returns: `fhirBaseFor(tenant)`, the same value as the
token audience. `patient` on that route is now **optional**. An EHR launch
with no patient is valid SMART: the handle carries no patient, the token
response has no `patient` and no `need_patient_banner`, and every `patient/`
scope is dropped as for a standalone launch without a patient. When a patient
is supplied it must still be a valid FHIR id, and the flow is unchanged.

`POST /api/health/auth/tenants/{t}/patient-search` (control-plane write auth,
like `launch`; body `{oid, q, birthdate?}`, `q` 1-100 characters, `birthdate`
a FHIR date) runs the picker's search for that `oid`. It uses the same 60 s
user token, with `user/Patient.rs` intersected with that user's role
ceilings and `idp_tid` set to the control plane's own Entra tenant. Every
honest failure is **HTTP 200 with a flag**, never invented rows:
`{unavailable: true, reason}` when the FHIR search throws
`PatientSearchUnavailableError` or role membership cannot be established,
and `{notPermitted: true, patients: []}` when no role carries
`user/Patient.rs` (the FHIR search is then not called). A 400 means a bad
request and a 5xx means a control-plane fault. While the FHIR edge is not
deployed, the console shows "Patient search is unavailable" and offers
"Launch without a patient" as the primary action. Search terms travel only
in POST bodies. Tests: `test/auth-server.test.ts` (EHR launch without a
patient; admin patient search).

Two limits apply. First, deleting a mapping does not reach sessions already
issued. A refresh carries the `fhirUser` stored at sign-in and does not re-read
the mapping, so an existing refresh token keeps the old value until it expires
(30 days). To end those sessions, disable the client. Second, mappings are not
removed when their tenant is destroyed (#5463).

### A2. Scope grammar LHDS accepts

`<compartment>/<type>.<perms>[?<constraint>]`

| Part | Accepted | Rejected (scope dropped from the grant, never widened) |
|---|---|---|
| compartment | `patient`, `user` (authorization-code grant); `system` (client-credentials grant only) | `system/` in authorization-code; `patient/` or `user/` in client-credentials |
| type | a FHIR R4 resource type, or `*` | unknown type names |
| perms (v2) | a non-empty, **in-order** subset of `cruds` | out-of-order (`.sr`), repeated (`.rr`) or unknown (`.x`) letters. The spec says these "MAY be ignored"; LHDS chooses to ignore them |
| perms (v1) | `.read` -> `.rs`, `.write` -> `.cud`, `.*` -> `.cruds` (spec v1 mapping) when the tenant's v1 flag is on (`PRP/AHDS-MODEL-MAP.md:32` "v1 compatibility flag") | v1 forms when the flag is off |
| constraint | exactly one `category=<system>\|<code>` or `category=<code>` on `Observation`, `Condition`, `DocumentReference` | any other parameter, more than one parameter, or `category` on any other type. Granting such a scope without its constraint would be an over-grant |
| context / identity | `openid`, `fhirUser`, `launch`, `launch/patient`, `offline_access` | `launch/encounter`, `online_access` and `profile` are not advertised in v1 (Q3) |

Two normalisations are fixed so the Rego bundle parses **one** grammar:

1. The JWT `scope` claim (A7) carries **v2 form only**: v1 requests are
   rewritten, and duplicate scopes are collapsed.
2. The token **response** `scope` echoes the granted scopes in the client's own
   syntax, because SMART clients compare the response with their request.

The discovery document advertises `permission-v2`, `permission-patient`,
`permission-user` and `permission-offline`. It adds `permission-v1` only when
the tenant flag is on. `code_challenge_methods_supported` is exactly `["S256"]`:
the spec requires S256 to be listed and `plain` never to be.

### A3. Launch contexts

| Flow | Request | AS behaviour | Token response / claims |
|---|---|---|---|
| Standalone, patient picked | `launch/patient` + `patient/...` scopes | After Entra sign-in, the AS shows a patient picker for the tenant. The picker searches with the **user's own** `user/Patient.rs` ceiling. A user without that ceiling cannot pick; the picker says so and offers only Cancel (`access_denied`). When no `patient/` scope would be granted at all, there is no picker and the code is issued without a patient | `patient` = chosen id; `need_patient_banner: true`; `tenant` = tenant slug |
| EHR launch | `launch` scope + `launch=<handle>` | The handle is minted by the Loom item editor (ADR-010:20). It is **single-use**, valid for 5 minutes or less, and bound to (tenant, Entra `oid`, `client_id`, and an optional patient, encounter and `fhirContext`). A different user, a different client, a second use or expiry is refused | `patient` and `need_patient_banner: false` when a patient is bound (neither when none is, #5454 A6), `encounter` when bound, `fhirContext` when bound, `tenant` |
| Identity | `openid fhirUser` | `id_token` signed by the AS. `fhirUser` is the absolute URL of the Practitioner, Patient, RelatedPerson or Person the operator mapped to the Entra user in that tenant (Q5; the fhir-users admin routes, A12). **If no match exists, `fhirUser` is not granted.** Inventing a URL is forbidden | `id_token` |
| Refresh | `offline_access` | A refresh token is issued only when at least one data scope is granted. **Every refresh re-runs the full mapping (A4)**, so a removed group membership shrinks the scopes at the next refresh. A refresh never adds scopes beyond the original grant | new `access_token`, `scope` |

`patient/` scopes without an established patient context are dropped at
issuance. A token that still somehow carries a `patient/` scope with no
`patient` claim is denied for every `patient/` access by the PDP (A7, N21).

### A4. Role-to-scope mapping (ceiling, not grant)

The canonical machine-readable table is
`apps/loom-health-cp/src/auth/role-scope-map.v1.json` (`version`
`lhds-scope-map/1`). It exists so that the W1-5 scope-matrix test can be
*generated from* it, and so that "a new scope without a row fails the build"
(`PRP/TEST-STRATEGY.md:145-147`). Lift values from the JSON; do not transcribe
them from this page. The role names mirror AHDS
(`PRP/AHDS-MODEL-MAP.md:33,59`, `PRP/SECURITY-AND-COMPLIANCE.md:54`). The
**AHDS semantics behind each role were not re-read from Microsoft Learn for
this pass (UNVERIFIED)**, notably whether AHDS Writer includes delete. The
ceilings below are an LHDS decision, not a transcription.

| Role id | Authorization-code ceiling | Client-credentials ceiling | Role-gated operations (wave) |
|---|---|---|---|
| `fhir-data-reader` | `user/*.rs` `patient/*.rs` | `system/*.rs` | none |
| `fhir-data-writer` | `user/*.cruds` `patient/*.cruds` | `system/*.cruds` | none |
| `fhir-data-contributor` | `user/*.cruds` `patient/*.cruds` | `system/*.cruds` | `$purge-history` (W7) |
| `fhir-smart-user` | `user/*.rs` `patient/*.rs` | none | none |
| `fhir-data-exporter` | none | `system/*.rs` | `$export` (W6) |
| `fhir-data-importer` | none | `system/*.cu` | `$import` (W6) |
| `fhir-data-converter` | none | none | `$convert-data` (W5) |
| `fhir-bulk-operator` | none | none | `$bulk-delete` `$bulk-update` (W7) |
| `fhir-search-parameter-manager` | `user/SearchParameter.cruds` | `system/SearchParameter.cruds` | `$reindex` (W7) |
| `dicom-data-reader` | none | none | `dicom:read` (W3) |
| `dicom-data-owner` | none | none | `dicom:read` `dicom:write` `dicom:delete` (W3) |
| `mpi` | none | none | `mpi:$match` `mpi:$everything` (W11; ADR-006:32 also requires `user/Patient.rs`) |
| `health-tenant-admin` | none | none | none. Control plane only, never data (D12, `PRP/SECURITY-AND-COMPLIANCE.md:216`) |
| `break-glass` | none | none | none in W1. The W8 elevation flow defines it (`PRP/SECURITY-AND-COMPLIANCE.md:55`) |

**Intersection rule (normative).** For each requested scope `s`, and each
ceiling `c` from the union of the caller's role ceilings for the grant type:

1. `c` matches only when it has the **same compartment** as `s`.
2. The type matches when `c.type == '*'` or `c.type == s.type`.
3. The resulting permissions are `s.perms ∩ c.perms`.
4. When `c` is unconstrained, the result carries `s`'s constraint. When `c` is
   constrained, the result requires an identical constraint on `s`.

The grant is the union of the non-empty results, intersected the same way
with the client registration's allowed scopes. Worked examples:
`patient/*.cruds` against the ceiling `patient/*.rs` grants `patient/*.rs`
(narrowed). `user/Observation.c` against `user/*.rs` grants nothing (dropped).
An empty data-scope grant with `openid` alone still returns a token. An
empty grant overall returns OAuth `invalid_scope`.

Operations are **not** scopes. They travel in the `lhds_roles` claim (A7), and
the PDP checks them per request in addition to the scope.

### A5. Entra mapping per cloud

**How membership reaches the AS.** Each LHDS tenant holds a list of
**bindings** `(Entra group objectId -> role id)`. This is the *Access (roles ->
scopes)* tab on the `health-tenant` item (`PRP/LOOM-INTEGRATION.md:10`).
On every authorization and every refresh, the AS resolves the user's
membership of exactly the bound group ids **server-side through Microsoft
Graph**. It **never** trusts a `groups` claim carried by the client. That is
the threat model's control for group-claim injection
(`PRP/SECURITY-AND-COMPLIANCE.md:208`), and it also avoids the token
group-overage case. Entra app roles are not used for data roles because they
are not tenant-scoped. A VISN clinician must reach only that VISN's tenant.

**Storage gap.** `TenantDoc` has no bindings field
(`apps/loom-health-cp/src/registry/types.ts:90-100`), and `TenantPatchSchema`
is a `strictObject` that rejects unknown keys (`types.ts:64-73`). Bindings
therefore need either a new registry field (that is W1-3 code) or a new
Cosmos container owned by `src/auth/`. A new container needs a
`control-plane.bicep` row, because the README states that containers must
exist before start (`apps/loom-health-cp/README.md:53-58`). Q6 asks which.

**What differs per cloud:**

| Item | Commercial / GCC | GCC-High / IL5 | DoD | Source |
|---|---|---|---|---|
| Entra authority | `login.microsoftonline.com` | `login.microsoftonline.us` | `login.microsoftonline.us` | `apps/loom-health-cp/src/config.ts:11-17` |
| Graph host | `graph.microsoft.com` | `graph.microsoft.us` | `dod-graph.microsoft.us` | `apps/fiab-console/lib/azure/cloud-endpoints.ts:493` |
| Patient-facing identity | Entra External ID | B2B, Gov-to-Gov tenants only | same as GCC-High | D13 (`PRP/RISKS-AND-OPEN-DECISIONS.md:22`); `PRP/AZURE-GOV-AVAILABILITY.md:45` |
| App registration | one per Entra tenant per cloud | same | same | ADR-010:15-16 |
| Exercised? | Commercial: never (no AS yet). GCC: supported-in-code only, never exercised (`cloud-parity.md`) | never; IL5 has no recorded run (`PRP/ARCHITECTURE.md:177`) | `boundary` enum lacks DoD (`PRP/ARCHITECTURE.md:177`), so not deployable today | |

The role-to-scope table (A4) is **identical in every cloud**. Only the hosts,
the app registration and the patient-identity path vary (`cloud-parity.md`).

**Two discrepancies to carry into implementation:**

- ADR-010:29-30 says Gov endpoints are resolved "through the existing
  `cloud-endpoints.ts`". `loom-health-cp`, however, is a separate package with
  its own `AUTHORITY_BY_CLOUD` (`config.ts:11-17`) and **no Graph host
  resolver**. The implementation must add a `GRAPH_BY_CLOUD` that mirrors
  `cloud-endpoints.ts:493`, including the 3-way DoD split, plus a unit test per
  cloud.
- The Graph membership read needs an application permission on the AS
  identity that only a tenant admin can consent to. That is a genuine
  tenant-level consent and must be a registered gate with Fix-it
  (`auto-bind-by-default.md` "Allowed"). The exact least-privilege Graph
  permission and call (`checkMemberGroups` vs `transitiveMemberOf`) is
  **UNVERIFIED** (Q7).

**Tenant-of-identity rule.** The `tid` of the authenticating Entra user must
equal the Entra tenant bound to the LHDS tenant. v1 binds every LHDS tenant to
the control plane's single Entra tenant (`config.ts:57,67-68`). Multi-Entra
customers are Q8.

### A6. Backend Services (client credentials with a JWKS)

Registration record, owned by `src/auth/`: `client_id`, LHDS `tenant`, either
`jwksUrl` (TLS, unauthenticated; strongly preferred by the spec) **or** a JWKS
held by value (the spec requires servers to support both), allowed `system/`
scopes, role ids, and status.

**Key normalization (#5518; merged, not deployed).** The CP stores and
verifies with ONLY key material it re-derived itself
(`src/auth/jwk-normalize.ts`), whichever admin-API caller registered it. A
key may carry only `kty kid alg use key_ops x5c x5t#S256` plus `crv x y` (EC)
or `n e` (RSA); a boolean `ext` is accepted and dropped; anything else,
including `x5t` (SHA-1) and an own `__proto__`, is `400`. EC is P-384 with
48-byte `x`/`y`; RSA has `e` of at most 4 bytes and `n` of 2048 to 8192 bits;
`alg` is ES384 / RS384, `use` is `sig`, `key_ops` is exactly `["verify"]`. The
key is round-tripped through `createPublicKey` (an off-curve point is refused)
and only its export is kept. Each `x5c` entry (at most 5) must be exactly one
certificate's DER, so a certificate with bytes appended is refused; only the
certificate is kept, `x5c[0]` must hold the JWK's key, and `x5t#S256` is
recomputed. A stored by-value JWKS is re-normalized on every verification: if
any key fails, the whole stored set is treated as absent and
`auth.client_jwks_invalid {clientId}` is logged (fail closed). A fetched
`jwksUrl` document is normalized per key: a key that fails is dropped and
`auth.client_jwks_keys_dropped {clientId, dropped}` is logged. That includes a
published key that carries `x5t`, so such a key is unusable here.

Verification order on `POST token_endpoint` with
`grant_type=client_credentials`,
`client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`,
`client_assertion`, `scope`. Every failure returns **`invalid_client`**,
except an empty scope grant, which returns `invalid_scope`.

1. JOSE header: `typ` is `JWT`. `alg` is in `{RS384, ES384}`; anything else,
   including `none`, `HS*` and `RS256`, is refused. `kid` is present.
2. Claims: `iss == sub == client_id` of a registered, active client.
   `aud ==` the exact `token_endpoint` URL. `exp` is in the future and **no
   more than 300 s ahead** of AS time; LHDS allows 60 s of clock skew on the
   past side only. `jti` is present.
3. If `jku` is present it must equal the registered `jwksUrl` exactly,
   otherwise refuse. If it is absent, use the registered URL or the by-value
   set.
4. Select keys by `kid` and a `kty` consistent with `alg`. Exactly one key must
   match; zero or two is refused.
5. Verify the signature.
6. Replay: `(iss, jti)` is stored with a TTL of `exp + skew`. A second
   presentation is refused. The store must be shared across AS replicas: a
   Cosmos container with TTL, created-if-absent so that a 409 means replay.
   That is a new container (Q6).
7. JWKS caching: never longer than the client's `Cache-Control` allows (spec
   "SHALL NOT").
8. Response: `token_type: bearer`, `expires_in: 300`, `scope` = the granted
   `system/` scopes. **No refresh token** (spec "SHOULD NOT").

**Egress consequence.** Fetching a client's `jwksUrl` is outbound traffic. The
stamp egress is an FQDN allow-list maintained in bicep
(`PRP/SECURITY-AND-COMPLIANCE.md:101-103`). The control plane runs as a
Container App rather than on a stamp (`PRP/ARCHITECTURE.md:88-89`), so the
control plane's own egress posture governs these fetches. Whether a JWKS host
must be allow-listed per client is Q9.

### A7. Access-token claims contract (the PDP input; W1-5 builds Rego against this)

Format: a JWT signed by the AS, with header `typ: at+jwt` (RFC 9068), `alg:
ES384` and `kid`. The PDP validates against the AS JWKS. Contract version:
`lhds_ver = "lhds-at/1"`. **The PDP denies every request whose token fails any
row below.** No row has a default; a missing claim means deny.

| Claim | Type | Value | PDP rule |
|---|---|---|---|
| `iss` | string | the AS issuer URL for this cloud's control plane | exact match with the bundle's configured issuer. **An Entra issuer is denied** (engines never accept Entra tokens, ADR-010:27-28) |
| `aud` | string (single) | the exact base URL the client named in the authorize `aud` parameter: the tenant FHIR base (`https://<tenant>.health.<loom-domain>/fhir`, `PRP/AHDS-MODEL-MAP.md:39`) or its path-prefix form (ADR-006:6) | equals the base URL of the request (A8) |
| `exp`, `iat` | number | `exp - iat` ≤ 300 s for `system`; user tokens default 300 s (Q10) | `now < exp`; `iat ≤ now + 60` |
| `jti` | string | unique | carried into the audit record |
| `lhds_ver` | string | `lhds-at/1` | any other value is denied |
| `tenant` | string | LHDS tenant slug, matching `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$` (`registry/types.ts:7`). Also returned as the SMART `tenant` launch parameter | A8 |
| `sub` | string | Entra `oid` (user) or `client_id` (system) | audit only |
| `sub_type` | `"user"` \| `"system"` | from the grant type | `system/` scopes are honoured only when `system`; `user/` and `patient/` only when `user` |
| `idp_tid` | string (GUID) | Entra tenant of the authenticated identity; absent for `system` | audit only (enforced at issuance, A5) |
| `client_id` | string | the SMART client | audit; obligations |
| `scope` | string, space-delimited | granted scopes in **v2 form only** (A2); context scopes included | parsed with the A2 grammar. An unparseable scope is ignored, never widened |
| `patient` | string | FHIR logical id | **required for any `patient/` scope**. Without it, every `patient/` access is denied |
| `encounter` | string | optional | informational in W1 |
| `fhirUser` | string (URL) | present only when granted (A3) | informational in W1 |
| `lhds_roles` | string[] | role ids from A4 that contributed to the grant | operation gates (A4 last column) |
| `lhds_map_ver` | string | `lhds-scope-map/1` | audit (the evidence pack's role/scope inventory, `PRP/SECURITY-AND-COMPLIANCE.md:309-310`) |
| `pou` | string[] | purpose of use, v3-ActReason codes. W1 issues `TREAT` for users and the registered value for clients; **`BTG` is never issued in W1** | input to the W8 consent rules; W1 only logs it (Q11) |

**Reserved, not issued in W1:** `act` (RFC 8693 delegation for the Loom BFF,
`PRP/SECURITY-AND-COMPLIANCE.md:56`, `PRP/LOOM-INTEGRATION.md:39`) and `cnf`
(DPoP, D15 in the threat model). The PDP must **deny** a token that carries
either claim until a later contract version defines it. That prevents a
half-implemented delegation from being honoured.

**Request-side inputs the PDP needs.** The interceptor contract is owned by
W1-5 and listed here only so the claims above are sufficient: `tenant` (from
the URL), `base` (the tenant public FHIR base, the engine configured server address without the facility partition; not the URL as received, #5422 decision 13), `interaction`
(`read|vread|search|create|update|patch|delete|history|operation`), `type`,
`id`, `op`, search params, and for patient-compartment checks the resource's
patient-compartment owners as resolved by the engine (ADR-011:12-15).

**Scope evaluation in Rego.** A request is permitted only when some granted
scope matches all four of:

1. The compartment fits `sub_type`.
2. The type matches, or the scope type is `*`.
3. The interaction's letter is in the perms: create is `c`; read, vread and
   history-instance are `r`; update and patch are `u`; delete is `d`; search
   is `s`.
4. For `patient/`, the target is in the `patient` compartment. A search must
   be bound to that patient; an unbound search is denied, not silently
   filtered.

A constrained scope permits a search only when the search carries the same
`category`, and a read only when the resource has it. The tenant rule (A8)
must also hold.

### A8. Tenant-match rule

All of the following must hold. Any failure is **403**, audited with both
values. Comparisons are exact, with no case-folding, trimming or Unicode
normalisation.

- **T1** The `tenant` claim equals the tenant resolved from the request (URL
  prefix `/{tenant}/...` or host `<tenant>.health...`). A mismatch is 403
  (ADR-006:6-8).
- **T2** `aud` equals the base URL of the request, and that base belongs to the
  same tenant in the bundle's tenant map.
- **T3** The tenant is homed on this stamp. The bundle carries the stamp's
  tenant list from the routing map (`apps/loom-health-cp/src/routing/` is the
  publisher, `README.md:10`). A token for a tenant on another stamp is denied
  even when T1 and T2 hold, which protects against a mis-route.
- **T4** At issuance (AS side): the Entra `tid` equals the tenant's bound Entra
  tenant (A5), and the tenant status is `active`. `TENANT_STATUSES` is in
  `registry/types.ts:13`. A `suspended` or `destroying` tenant gets no token.

### A9. Negative-scope test matrix

Every **deny** row is paired with a **permit** control: the same token and the
same fixture with one variable changed. That pairing is required by
`assertion-design.md` "done" #4. The *Breaks if* column names the defect that
turns the row red. Rows N1-N17 and N21-N22 run against the PDP (W1-5 `opa
test`, generated from `role-scope-map.v1.json`). The other rows run against
the AS (W1-4 tests).

| # | Input | Expected | Paired permit control | Breaks if |
|---|---|---|---|---|
| N1 | `patient/Observation.rs`, read `Condition/c1` in the patient's compartment | deny | read `Observation/o1`, same patient: permit | type match ignores the type (`TEST-STRATEGY.md:37-40`) |
| N2 | `patient/Observation.rs`, read `Observation/o2` of **another** patient | deny | `o1` of the token's patient: permit | the compartment check is skipped |
| N3 | `patient/Observation.rs`, search `Observation` with no `patient` param | deny | search `Observation?patient=<p>`: permit | an unbound search is allowed or filtered silently |
| N4 | `user/Observation.rs`, create `Observation` | deny | search `Observation`: permit | perms letters are not checked |
| N5 | `user/Observation.r`, search `Observation` | deny | read `Observation/o1`: permit | `r` and `s` are conflated |
| N6 | requested `user/Observation.sr` | not granted (absent from `scope`) | requested `user/Observation.rs`: granted | the parser sorts or accepts out-of-order letters |
| N7 | `patient/Observation.rs?category=laboratory`, read a `vital-signs` Observation | deny | a `laboratory` Observation: permit | the constraint is dropped by the PDP |
| N8 | requested `patient/Observation.rs?code=1234-5` | not granted | `?category=laboratory`: granted | the AS strips an unsupported constraint and widens the scope |
| N9 | `fhir-smart-user` requests `user/Patient.cruds` | granted `user/Patient.rs` exactly | reader requests `user/Patient.rs`: granted | the intersection returns the request unmodified (**mutation arm for the W1-4 receipt**) |
| N10 | `health-tenant-admin` only; read `Patient/p` | the token carries no data scope; PDP deny | the same user plus `fhir-data-reader`: permit | the admin role inherits data access (D12) |
| N11 | authorization-code flow requests `system/*.rs` | not granted | client-credentials with the exporter role: granted | the compartment is not tied to the grant type |
| N12 | client-credentials requests `patient/*.rs` | `invalid_scope` | `system/*.rs`: granted | same as N11, reverse direction |
| N13 | token `tenant=visn-01`, URL `/visn-02/fhir/Patient/p` | 403 | URL `/visn-01/...`: permit | the PDP takes the tenant from the token alone (T1) |
| N14 | token `aud` = the visn-01 FHIR base, request to the visn-01 DICOMweb base | deny | request to the FHIR base: permit | `aud` is not compared (T2) |
| N15 | token `tenant=visn-01`, request tenant `Visn-01` | deny | `visn-01`: permit | the comparison case-folds (A8) |
| N16 | a valid **Entra** token for the AS audience | deny | an AS-issued token: permit | `iss` is not pinned (ADR-010:27) |
| N17 | `lhds_ver="lhds-at/2"`; or `act` present; or `exp=now-1` | deny (three cases) | `lhds-at/1`, no `act`, valid `exp`: permit | an unknown version, a reserved claim or expiry is tolerated |
| N18 | backend assertion with (a) `jku` ≠ registered URL, (b) a replayed `jti`, (c) `exp=now+301`, (d) `alg=RS256`, (e) `aud` ≠ token URL, (f) two keys sharing the `kid` | `invalid_client` (six cases) | a well-formed assertion: token issued | each verification step of A6 is skipped |
| N19 | EHR `launch` handle reused, or presented by another `oid`, or by another `client_id` | refused (three cases) | first use by the bound user and client: token with `patient` | the handle binding is not checked (A3) |
| N20 | refresh after the user is removed from the bound group | refresh refused, or `scope` loses the role's scopes | refresh with membership intact: same scopes | refresh replays the stored grant without re-running A4 |
| N21 | a token carrying a `patient/` scope but no `patient` claim | deny every `patient/` access | with `patient`: permit | a missing claim defaults to permit |
| N22 | `patient/*.rs`, create `Condition` | deny | read `Condition` in the compartment: permit | the wildcard type also wildcards the perms |
| N23 | authorize with `code_challenge_method=plain`, or no `code_verifier` at the token step | refused | S256: code exchanged | PKCE is not enforced |

**Mutation receipt for the W1-4 verify column.** In a **sandbox copy** (never
the tracked tree, per `assertion-design.md` "done" #2), apply each arm and
record red, then green against the unmutated code:

| Arm | Mutation | Must turn red |
|---|---|---|
| (i) | the intersection returns `s` unchanged | N9 |
| (ii) | the A6 `jku` comparison is removed | N18a |
| (iii) | refresh skips the Graph re-check | N20 |

A green arm is reported as one of: blind test, weak mutation, or equivalent
mutant, with the reason.

### A10. Implementation choice (recorded for ADR-010)

| | **Selected candidate: `node-oidc-provider` embedded in `loom-health-cp`** | Fallback 1: Medplum authorizer extracted | Fallback 2: minimal authorizer on `jose` |
|---|---|---|---|
| Licence | MIT (ADR-010:24). Acceptable; AGPL is the only class excluded (`OPERATOR-DECISIONS-2026-10-22.md:23`) | Apache-2.0 (ADR-010:25) | jose is already a dependency (`apps/loom-health-cp/package.json:25`) |
| Why | Same runtime and language as the service (`package.json:9,22-27`). An OAuth 2.x / OIDC server with PKCE, client-credentials, `private_key_jwt` and resource indicators. **UNVERIFIED: none of its code or docs was read for this pass** | A complete SMART authorizer. **UNVERIFIED**: believed to be coupled to Medplum's own FHIR-resident client and membership model, which would mean carrying that model | Implements only A3, A6 and A7; nothing else |
| Risk | SMART-specific behaviour (launch handles, patient picker, scope intersection, the `tenant`/`patient` response params) is custom code on its extension points | Extraction cost; a second data model | Every OAuth edge case is ours; highest review burden |

**Pass bar.** The candidate is confirmed only by the W1-4 implement receipt,
never by this design. It must meet all of the following:

1. The Inferno SMART App Launch kit (STU2: standalone and EHR launch, v2
   scopes, PKCE, refresh) has **zero failures** against the Commercial sandbox
   stamp (`W01-control-plane-identity-stamp.md:30`). The value that breaks it
   is any `fail` row in the Inferno JSON.
2. Matrix rows N1-N23 run, with arms (i)-(iii) red-then-green.
3. Access-token and `id_token` signing keys are **non-exportable Key Vault keys
   (HSM-backed)**, with signing done by the Key Vault `sign` operation. If the
   library can only sign with in-process private keys, this item fails unless
   the operator accepts the alternative (Q1).
4. The Gov path: the authority and Graph hosts resolve per A5, verified with a
   unit test per cloud. The GCC-High receipt comes from a GitHub Actions run,
   never a workstation (`PRP/SECURITY-AND-COMPLIANCE.md:324-325`).

**Fallback trigger.** If criterion 1 or 3 is not met within **three
implementation sessions**, stop. Record the failing rows and move to
Fallback 1. Fallback 2 is used only if Fallback 1 fails the same bar. The
tokens are standard JWTs behind the same discovery document, so the swap
leaves A7 unchanged (ADR-010:39-41).

### A11. Open questions for the operator

- **Q1** Signing keys: require non-exportable HSM-backed Key Vault keys
  (recommended; this may force Fallback 2), or accept an exportable key
  injected through the CSI secret store
  (`PRP/SECURITY-AND-COMPLIANCE.md:168-173`)?
- **Q2** Default for v1 scope syntax per tenant: **on** (recommended; AHDS
  parity, `AHDS-MODEL-MAP.md:32`) or off?
- **Q3** The PRP lists `online_access` (`PRP/SECURITY-AND-COMPLIANCE.md:51`),
  but the spec marks `permission-online` experimental. Recommendation: ship
  `offline_access` only in v1. This is a stated deviation that needs the
  operator's sign-off.
- **Q4** Client registration surface (SMART apps and Backend Services JWKS):
  the `health-tenant` *Access* tab via a control-plane admin route
  (recommended), or a separate item? No route is defined in the PRP today.
- **Q5** `fhirUser` linkage: which FHIR identifier system links a Practitioner
  to an Entra `oid`, and which wave provisions Practitioner resources?
- **Q6** Bindings, the `jti` cache and launch handles: three new Cosmos
  containers owned by `src/auth/` (recommended; needs a `control-plane.bicep`
  row), or new `TenantDoc` fields (W1-3 code)?
- **Q7** Graph permission for the membership check on the AS identity:
  recommended least-privilege `GroupMember.Read.All` (application). This is
  UNVERIFIED as the minimum, and it is a tenant-admin consent gate.
- **Q8** Multiple Entra tenants per control plane (Commercial customers with
  their own Entra): in v1 or later? v1 as designed is one Entra tenant per
  control plane (`config.ts:57`).
- **Q9** Backend Services `jwksUrl` egress: allow-list each client's JWKS host
  in bicep (a reviewed change per client), or accept JWKS by value only in Gov?
- **Q10** User access-token lifetime: 300 s with refresh (recommended), or
  longer?
- **Q11** Purpose of use in W1: issue `TREAT` by default, or omit `pou` until
  W8?

### A12. Implementation record (W1-4 server half)

Code: `apps/loom-health-cp/src/auth/` (`scopes.ts` grammar and intersection, `role-map.ts` loader over the JSON, `grant.ts`, `signer.ts`, `tokens.ts`, `backend-auth.ts`, `federation.ts`, `server.ts`, `cosmos.ts`; the patient picker in `patient-search.ts` and `picker-page.ts`). Tests: `test/auth-core.test.ts`, `test/auth-server.test.ts`, `test/patient-picker.test.ts`, `test/cosmos-fhir-users.test.ts`.

**Decisions applied (operator, 2026-10-26).** Signing keys are non-exportable Key Vault keys (`KeyVaultSigner` signs a SHA-384 digest through the vault `sign` call, so no private key enters the process); `LocalSigner` is the disclosed fallback authorizer and is never selected by default. `offline_access` only (Q3). Client registration is a control-plane route family (Q4): `POST/GET /api/health/auth/clients`, `PATCH .../clients/{id}`, `PUT/GET .../tenants/{t}/bindings`, `POST .../launch`, `GET .../readiness`. Added by #5454 (A3): `PATCH .../clients/{id}` takes `{status?, launchUri?: string|null}` (at least one; `null` clears the launch URI; `status` behaves as before), `POST .../clients` accepts an optional `launchUri` for app clients, and the fhirUser mapping family `PUT/GET/DELETE .../tenants/{t}/fhir-users/{oid}` (body `{"resource": "Practitioner/<id>"}`; also `Patient`, `RelatedPerson`, `Person`; the oid must be a GUID and the tenant must exist; DELETE answers 204 and is idempotent) plus `GET .../tenants/{t}/fhir-users` (that tenant's mappings, at most 500). GET needs control-plane read; PUT and DELETE need write. Added by #5454 (A6): `POST .../launch` accepts no `patient` and returns `iss` (the tenant FHIR base) beside `launch` and `expiresAt`. `POST .../tenants/{t}/patient-search` needs write (see A1, "EHR launcher and admin patient search"). Three Cosmos containers (Q6): `health-auth-config` (bindings, clients and fhirUser mappings), `health-auth-replay` and `health-auth-grants` (both per-item TTL). The Graph consent check is a gate with a Fix-it descriptor on `readiness` (Q7). One Entra tenant in W1 (Q8).

**Not built, by design or dependency.** The standalone patient picker is built (#5454 A5, see A1), but its live search depends on the FHIR edge, which is in code (G1) and not yet deployed, so today it can only render the unavailable state. `fhirUser` is granted only when the fhirUser mapping resolves (wired in `wire.ts` since #5454; before that no resolver existed). The AS routes, the picker included, are live on Commercial dev01 behind the Front Door `/auth/*` route (see the status note at the top). Gate-registry registration of the consent gate is a console change.

**UNMEASURED.** The Inferno SMART App Launch kit (pass bar criterion 1) was not run. Key Vault `sign`, Entra token exchange and Graph `checkMemberGroups` were exercised only against fakes: their request shapes are unverified against the live services, and `GroupMember.Read.All` as the least-privilege permission stays UNVERIFIED (Q7). No cloud receipt exists for any boundary. N1-N8 (except N6/N8 grammar), N13-N17 and N21-N22 are PDP rows owned by W1-5.

**Consequence of the intersection rule worth knowing.** A wildcard request (`user/*.cruds`) against a client allow-list naming specific types (`user/Patient.rs`) grants nothing, because rule 2 matches a `*` request only to a `*` ceiling. Register `*` allow-lists, or have apps request typed scopes.

## Per-tenant FHIR engine NetworkPolicy (#5441)

Each engine gets a `networking.k8s.io/v1` NetworkPolicy named like the engine (`fhir-<slug>`), applied in the same `kubectl apply` and deleted in the same teardown (`removeEngine`). The stamp AKS runs Cilium (`aks.bicep:217-219`), which enforces it.

- **Selects** only that tenant's pods (`app` and `loom.health/tenant`), so no other engine in `loom-health` is reachable through it.
- **Ingress**, TCP 8080 only (the container port, not Service port 80), from: the `aks-command` namespace (runCommand pods, including the B3 CRUD probe) and `kube-system` pods labelled `app=konnectivity-agent` (the API server service proxy that `probeEngine` uses for `/metadata`). Every peer carries a non-empty selector; an unscoped peer is refused at render time.
- **Edge** (G1; in the stamp bicep, not yet deployed or verified live): the stamp FHIR edge router (`platform/fiab/bicep/modules/health/edge-router.bicep`, a Loom-owned OSS nginx in namespace `loom-health-edge`, pods labelled `app=loom-health-edge`) is admitted through the `edgePeers` option of `renderEngineManifest` (`EDGE_ROUTER_PEER`), never by widening the base peers. `applyEngineConfig` passes it on every apply. The rendered revision includes a sha256 of exactly that peer list (`ingressPeersTerm` in `fhir-tenant-config.ts`), so an engine created before the edge, or before any later peer change, differs in revision. The control plane's engine drift reconciler (#5482 item 6, `fhir-engine-reconcile.ts`; see runbooks.md "Engine drift reconciler") finds that difference at startup and every 30 minutes and re-applies the engine through `fhir-tenant.reconcile`, with no user step; `fhir-tenant.create` / `.configure` still re-apply it too. Because the revision is also a pod-template annotation, that re-apply is a one-time rolling restart of each engine. Until it runs, the old policy drops the router's connection, which the router reports after its 5 s connect timeout as a 504 OperationOutcome. The reconciler is in code, not yet deployed or verified live. See "FHIR edge router" below.
- **Egress is NOT restricted.** PostgreSQL is reached by FQDN in a delegated subnet whose CIDR the control plane is not given, and workload identity needs `login.microsoftonline.com`; a Kubernetes NetworkPolicy cannot express an FQDN (Cilium FQDN policy needs paid ACNS). A guessed CIDR would break the live CRUD path. Requests remain gated by the PDP interceptor.
- **Not verified live yet**: the konnectivity-agent label. After the CP roll, `probeEngine` must still report `ready=true` and `lhds-fhir-crud-probe.yml` must pass 7/7.

## FHIR edge router (G1, #5410)

**Status: in code, not deployed, not verified live.** No request through a stamp ingress has reached an engine yet; the receipt is a `GET https://<stamp ingress>/<tenant>/fhir/metadata` read back after deploy-health has applied the router.

The stamp App Gateway forwards every request to one internal-LB address (`network.bicep` `ingressIlbIp`). Before G1 nothing listened there. `platform/fiab/bicep/modules/health/edge-router.bicep` renders the listener: a Loom-owned OSS nginx (`nginxinc/nginx-unprivileged`, pinned by digest in `edge-router-image.json`, imported into the hub registry by the same deploy-health step as the PDP image) behind an INTERNAL `LoadBalancer` Service that requests exactly the address the gateway's `ingress-ilb` pool holds (read from the deployed gateway, not re-derived). deploy-health applies the manifest with `aks-apply-manifest.sh` and then reads the Service's load-balancer address back; a Service still `<pending>` fails the run. The router deploys exactly when the PDP does, on every boundary (no boundary-specific branch).

Routing (`edge-router-nginx.conf`):

| Request | Goes to |
|---|---|
| `/{tenant}/fhir/.well-known/smart-configuration` | `{issuer}/{tenant}/.well-known/smart-configuration` over TLS (SNI on, certificate verified), no `Authorization` or `Cookie` forwarded. Not proxied when the issuer is the stamp ingress itself (it would loop): 404 OperationOutcome. |
| `/{tenant}/fhir[/...]` | `http://fhir-{tenant}.loom-health.svc.cluster.local:80/fhir[/...]`, query string kept, `Authorization` unchanged, `X-Forwarded-Proto: https`, `X-Forwarded-Host` (the gateway's `X-Original-Host`), `X-Forwarded-For`, `X-Forwarded-Prefix: /{tenant}` |
| unknown tenant (no Service: NXDOMAIN) | 404 OperationOutcome (`not-found`) |
| engine did not answer (incl. a policy drop) | 504 OperationOutcome (`timeout`) |
| anything else | 404 OperationOutcome |

`{tenant}` is the control plane's SLUG shape (2 to 40 of `[a-z0-9-]`, no leading or trailing hyphen). Engine errors are NOT rewritten (no `proxy_intercept_errors`): an engine's own 401/403 OperationOutcome reaches the client. The body cap and timeouts are the gateway's (WAF file-upload limit, backend request timeout), read from the deployed resources; bodies stream. `server_tokens` is off.

**The router does no authorization.** It maps a path to a Service. The tenant boundary is the engine's PDP interceptor, which checks the forwarded bearer token against the tenant the engine serves; a request routed to another tenant's engine is refused there.

Pod posture: non-root (uid 101), read-only root filesystem with a `/tmp` emptyDir, all capabilities dropped, seccomp `RuntimeDefault`, no service-account token, 2 replicas with a PodDisruptionBudget, readiness and liveness on `/healthz`. Its NetworkPolicy admits ingress on TCP 8080 from any source (the gateway arrives through the internal LB, whose source address the node may SNAT, so a source CIDR would be a guess) and allows egress only to cluster DNS, tenant engine pods (TCP 8080) and TCP 443 (the issuer; a NetworkPolicy cannot name an FQDN, so in firewall egress mode the stamp firewall allow-list is the FQDN control).

Known limits: nginx forwards the DECODED path, so a percent-encoded character in a FHIR path (rare: resource ids are `[A-Za-z0-9.-]`) reaches the engine decoded. Discovery through Front Door needs the issuer host on the firewall allow-list, which health.bicep adds only when it deployed the Front Door issuer (an `authIssuerUrl` override in firewall mode is not added).
