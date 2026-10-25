# loom-health-pdp

Per-stamp policy decision point for CSA Loom Health Data Services (ADR-011, W1-5).
OPA + Rego bundle v1: token contract `lhds-at/1`, tenant match, SMART v2 scopes,
role-gated operations. Deny by default. Azure-native, no Fabric dependency.
Holds policy only, never clinical data.

Depends on W1-4 (PR #5127): `apps/loom-health-cp/src/auth/role-scope-map.v1.json`
is the single mapping source, staged into the bundle by `tools/stage-policies.mjs`.
Contract text: `docs/fiab/health/security.md` section A7/A8.

## Decision API (what the HAPI / dcm4chee interceptors call)

OPA's native Data API, in-cluster only:

```
POST /v1/data/lhds/authz/decision
{ "input": { "access_token": "<raw JWT>", "request": {...} } }
-> { "result": { "allow": bool, "reason": str, "policy_version": str, "obligations": [] } }
```

Input shape: `input-contract.json`. The PDP verifies the token itself (ES384
against `data.lhds.config.jwks`); the interceptor passes the RAW token and the
request facts (`tenant` from the route, `base` as received, `interaction`,
`resource_type`, `op`, engine-resolved `patient_compartment`, `categories`).

Reasons, in evaluation order: `invalid-input`, `token-invalid` (signature, alg
not ES384, typ not at+jwt), `claims-invalid` (any missing/ill-typed claim, bad
sub_type, non-slug tenant, `pou` BTG, user without `idp_tid`),
`version-unsupported`, `reserved-claim` (`act`/`cnf`), `issuer-mismatch` (Entra
issuer), `token-time-invalid` (expired, iat > now+60 s, exp-iat > 300 s),
`tenant-mismatch` (exact), `tenant-not-on-stamp`, `audience-mismatch`,
`unknown-interaction`, `scope-denied`, `role-denied`, `permit`.

Interceptor rules the PDP relies on:

- Anything but `result.allow == true` is deny, including a missing `result`
  (OPA returns `{}` for undefined), a timeout, a 5xx or a connection error
  (fail closed, 503; ADR-011).
- `request.tenant` comes from the route, never the body.
- Scopes are v2 form only; unparseable, out-of-order or unsupported-constraint
  scopes grant nothing. `category` constraints compare by exact string.
- Roles are NOT a grant of scopes (the AS applies the ceiling at issuance). The PDP
  uses `lhds_roles` only for operations (`$export`, ...) and DICOM, via the role map.

## Bundle data supplied per stamp (not in git)

| Path | Content | Source |
|---|---|---|
| `data.lhds.config` | `{issuer, jwks}`: AS issuer URL, AS JWKS as a JSON string | control plane |
| `data.lhds.stamp` | `{tenants: {<slug>: {bases: [<base url>...]}}}` | control plane routing map |

Missing config or stamp makes every request deny (no token verifies / no tenant is
homed). The control-plane endpoint that adds these and serves the signed tarball
(`GET /api/health/pdp/stamps/{stamp}/bundle.tar.gz`) is NOT implemented yet; it is
a follow-up item.

## Layout

| Path | Purpose |
|---|---|
| `policies/lhds/authz/authz.rego` | decision rules |
| `policies/lhds/interactions/data.json` | interaction to CRUDS letter / DICOM op |
| `tests/authz_test.rego` | deny-rule tests over real signed tokens, each pairs a permit control and names the input that breaks it |
| `tests/jwt_fixtures.rego` | NOT committed (secret scanners flag JWT-shaped strings): `node tools/gen-jwt-fixtures.mjs` writes it before each test run, with a throwaway key (private half discarded) |
| `tests/scope_matrix_test.rego` | GENERATED from the role map + interactions (`tools/gen-scope-matrix.mjs`, `--check` fails when stale); verification mocked at the `token_valid`/`claims`/`now` seam |
| `tools/stage-policies.mjs` | stage `policies/` + role map into a bundle tree |
| `tools/build-bundle.sh` | stage, build, ES256-sign, verify |
| `config/opa-config.yaml` | OPA bundle/signing/keys template |

## Test

```
node tools/gen-jwt-fixtures.mjs   # required first: writes tests/jwt_fixtures.rego (gitignored)
node tools/stage-policies.mjs ../../temp/stage
node tools/gen-scope-matrix.mjs --check
opa test ../../temp/stage tests
opa check --strict --schema input-contract.json ../../temp/stage
```

Pinned OPA: v1.9.0. Note: avoid long `else` chains with `!=` in bodies; OPA 1.9
re-prints them incorrectly when bundling (hence `version_ok` and friends).

## Open items

- Operation gate (`$export`, ...) requires the role AND at least one data scope valid
  for the sub_type; W1-4 does not define a per-operation scope letter. Reconcile.
- `patient_compartment` and `categories` are provisional until W2-3 / W3-3 exist.
- A multi-owner target is permitted only when every owner is the token patient.
- Decision latency p95 < 10 ms in-cluster: UNMEASURED (needs a deployed stamp). ES384
  verification is on the decision path.
