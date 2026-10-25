# loom-health-pdp

Per-stamp policy decision point for CSA Loom Health Data Services (ADR-011, W1-5).
OPA + Rego bundle v1: SMART scopes, roles, tenant match. Deny by default.
Azure-native, no Fabric dependency. Holds policy only, never clinical data.

## Decision API (what the HAPI / dcm4chee interceptors call)

OPA's native Data API, in-cluster only:

```
POST /v1/data/lhds/authz/decision
{ "input": { "token": {...}, "request": {...} } }
-> { "result": { "allow": bool, "reason": str, "policy_version": str, "obligations": [] } }
```

Input shape: `input-contract.json` (PROVISIONAL: must be reconciled with the W1-4
token-claims contract). Reasons: `permit`, `tenant-mismatch`, `scope-denied`,
`unknown-interaction`, `invalid-input`.

Interceptor rules (the contract the PDP relies on):

- The interceptor verifies the token (JWKS) first; the PDP trusts claims only.
- `request.tenant` comes from the route, never the body.
- Treat anything but `result.allow == true` as deny, including a missing `result`
  (OPA returns `{}` when the document is undefined), a timeout, a 5xx or a
  connection error (fail closed, 503; ADR-011).
- v1 does not honour granular scopes (`?category=...`); they grant nothing.
- Roles are a grant, not a ceiling: effective scopes = token scopes + role bundles
  in `policies/lhds/mapping/data.json` (the single mapping table).

## Layout

| Path | Purpose |
|---|---|
| `policies/lhds/authz/authz.rego` | decision rules |
| `policies/lhds/mapping/data.json` | interaction to CRUDS letter, role to scope bundles, `version` |
| `tests/authz_test.rego` | hand-written tests, each names the input that breaks it |
| `tests/scope_matrix_test.rego` | GENERATED from the mapping table (`tools/gen-scope-matrix.mjs`; `--check` fails when stale) |
| `tools/build-bundle.sh` | build, ES256-sign, verify the bundle |
| `config/opa-config.yaml` | OPA bundle/signing/keys template |

## Test

```
node tools/gen-scope-matrix.mjs --check
opa test policies tests
opa check --strict --schema input-contract.json policies
```

Pinned OPA: v1.9.0 (sha256 of the windows binary `ea07eb41...c2951`).

## Bundle signing and distribution

CI builds with `tools/build-bundle.sh <key> <pub> <git-sha>`; the private key
comes from Key Vault, never the repo. OPA verifies the signature and file hashes
at load (`keys` + `signing.keyid`) and keeps the last-known-good bundle.
Control-plane side: serve the signed tarball at
`GET /api/health/pdp/stamps/{stamp}/bundle.tar.gz` (HealthCP caller auth).
That endpoint is NOT implemented yet (kept out of `apps/loom-health-cp` here to
avoid colliding with W1-4); it is a follow-up item.

## Not measured here

Decision latency p95 < 10 ms in-cluster needs the deployed stamp; unmeasured.
