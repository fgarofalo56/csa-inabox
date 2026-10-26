# Loom Health Data Services: security

> **Status: A1-A11 are the design; A12 records the W1-4 server code. Merged
> is not deployed.** This page currently holds only the **authorization
> section** (PRP item W1-4). The Authorization Server code lives in
> `apps/loom-health-cp/src/auth/` and is **not wired into `compose.ts` /
> `main.ts`, not deployed, and not run against Entra, Key Vault or Graph**
> (A12 lists what was and was not measured). The rest of this page (network,
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
document. No introspection, revocation, management or dynamic-registration
endpoint is designed or advertised. Client registration has no surface in the
PRP yet; see open question Q4.

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
| Standalone, patient picked | `launch/patient` + `patient/...` scopes | After Entra sign-in, the AS shows a patient picker for the tenant. The picker searches with the **user's own** `user/Patient.rs` ceiling. A user without that ceiling cannot pick, so every `patient/` scope is dropped | `patient` = chosen id; `need_patient_banner: true`; `tenant` = tenant slug |
| EHR launch | `launch` scope + `launch=<handle>` | The handle is minted by the Loom item editor (ADR-010:20). It is **single-use**, valid for 5 minutes or less, and bound to (tenant, Entra `oid`, `client_id`, patient, optional encounter / `fhirContext`). A different user, a different client, a second use or expiry is refused | `patient`, `encounter` when bound, `fhirContext` when bound, `need_patient_banner: false`, `tenant` |
| Identity | `openid fhirUser` | `id_token` signed by the AS. `fhirUser` is the absolute URL of the Practitioner, Patient or RelatedPerson whose identifier matches the Entra user (Q5). **If no match exists, `fhirUser` is not granted.** Inventing a URL is forbidden | `id_token` |
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
the URL), `base` (the base URL as received), `interaction`
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

Code: `apps/loom-health-cp/src/auth/` (`scopes.ts` grammar and intersection, `role-map.ts` loader over the JSON, `grant.ts`, `signer.ts`, `tokens.ts`, `backend-auth.ts`, `federation.ts`, `server.ts`, `cosmos.ts`). Tests: `test/auth-core.test.ts`, `test/auth-server.test.ts`.

**Decisions applied (operator, 2026-10-26).** Signing keys are non-exportable Key Vault keys (`KeyVaultSigner` signs a SHA-384 digest through the vault `sign` call, so no private key enters the process); `LocalSigner` is the disclosed fallback authorizer and is never selected by default. `offline_access` only (Q3). Client registration is a control-plane route family (Q4): `POST/GET /api/health/auth/clients`, `PATCH .../clients/{id}`, `PUT/GET .../tenants/{t}/bindings`, `POST .../launch`, `GET .../readiness`. Three Cosmos containers (Q6): `health-auth-config` (bindings and clients), `health-auth-replay` and `health-auth-grants` (both per-item TTL). The Graph consent check is a gate with a Fix-it descriptor on `readiness` (Q7). One Entra tenant in W1 (Q8).

**Not built, by design or dependency.** The standalone patient picker (needs a FHIR engine, W2, and a UI): `launch/patient` without an EHR launch handle grants no patient context, so every `patient/` scope is dropped. `fhirUser` is granted only when an injected resolver returns a URL (none is wired; Q5). Not wired into `compose.ts` / `main.ts`, so no route is live. Gate-registry registration of the consent gate is a console change.

**UNMEASURED.** The Inferno SMART App Launch kit (pass bar criterion 1) was not run. Key Vault `sign`, Entra token exchange and Graph `checkMemberGroups` were exercised only against fakes: their request shapes are unverified against the live services, and `GroupMember.Read.All` as the least-privilege permission stays UNVERIFIED (Q7). No cloud receipt exists for any boundary. N1-N8 (except N6/N8 grammar), N13-N17 and N21-N22 are PDP rows owned by W1-5.

**Consequence of the intersection rule worth knowing.** A wildcard request (`user/*.cruds`) against a client allow-list naming specific types (`user/Patient.rs`) grants nothing, because rule 2 matches a `*` request only to a `*` ceiling. Register `*` allow-lists, or have apps request typed scopes.
