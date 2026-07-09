# Scoped API tokens (PAT)

Scoped API tokens — Personal Access Tokens — let **non-interactive** clients
(CI pipelines, Terraform, SCIM provisioners, scripts) call the CSA Loom API
without a browser sign-in. A token is a long-lived, **revocable**, **scoped**
credential presented as a bearer header:

```
Authorization: Bearer loom_pat_<id>_<secret>
```

Until BR-PAT, Loom was session-cookie-only: `/api/auth/cli-session` mints a
browser-identical `loom_session` cookie and every route reads it. Tokens add a
first-class bearer scheme on top of the same identity model — a token resolves
to a **session-equivalent** for its creator, carrying a `pat` marker plus the
token's scope.

## Token anatomy

```
loom_pat_<id>_<secret>
          └─24 hex─┘ └────43 base64url chars────┘
```

* **`id`** — the public token id. Also the Cosmos document id / partition key.
* **`secret`** — 32 bytes of entropy, shown **once** at creation.

Loom stores a **SHA-256 hash of the secret only** — never the secret. A lost
token is unrecoverable; create a new one and revoke the old. This mirrors GitHub
and Azure DevOps PATs.

## Scopes

Every token carries exactly one typed scope (chosen from a dropdown — never
free-form):

| Scope | What it can do |
| --- | --- |
| **read-only** | `GET` / `HEAD` / `OPTIONS` only. Any mutating verb is rejected with `403 pat_scope_read_only`. |
| **read-write** | Full data-plane access *as the creator*. **No** admin surfaces. |
| **admin** | read-write **plus** admin surfaces — but only while the creator is still a tenant admin at the moment the token is used. |

Two invariants hold regardless of scope:

* A token can **never mint or revoke** further tokens — token management is a
  human, cookie-session-only surface (`403 pat_cannot_mint`).
* An **admin-scoped** token minted by a since-demoted user gets **no** admin
  power — the admin check re-runs on every request (`patCanAdmin`).

## Expiry

Tokens are short-lived by design: **default 30 days, hard maximum 90 days**.
Expiry is enforced at creation and re-checked on every request; presenting an
expired token is a denied, audited use.

## Creating a token

**Settings → Developer → API tokens** (`/settings/developer/tokens`):

1. Click **New token**.
2. Give it a recognizable **name** (e.g. `CI pipeline — prod deploy`).
3. Pick a **scope** and an **expiry** (7 / 30 / 60 / 90 days).
4. Copy the token from the one-time reveal dialog. **This is the only time it is
   shown.** Store it in your CI/secret store — never commit it.

## Using a token

Send it as a bearer header on any Loom API request. Verify it works with the
identity probe:

```bash
curl -H "Authorization: Bearer loom_pat_<id>_<secret>" \
  https://<your-loom-host>/api/v1/whoami
```

```json
{ "ok": true, "auth": "pat", "oid": "…", "upn": "…",
  "tenantId": "…", "scope": "read-write", "tokenId": "…" }
```

`GET /api/v1/whoami` accepts **both** a browser cookie (`auth: "cookie"`) and a
PAT (`auth: "pat"`), and echoes the caller's identity and — for a token — its
scope. It is the canonical "is my token working / what can it do" check.

### Resolution order

The PAT-aware resolver (`getApiSession`) is a strict **cookie-first** fallback:

1. If a valid browser `loom_session` cookie is present, it **wins** — the
   Authorization header is never consulted. Interactive requests behave exactly
   as before.
2. Otherwise the `Authorization: Bearer …` header is resolved against the token
   store.

## Revoking a token

* **Users** revoke their own tokens from **Settings → Developer → API tokens**.
* **Tenant admins** see every token in the tenant at **Admin → API tokens**
  (`/admin/developer/tokens`) and can revoke any one immediately.

Revocation takes effect on the token's **next request**.

## Auditing

Token lifecycle events emit to the SIEM audit stream (`LoomAudit_CL`, see
[SIEM audit stream](../operations/siem-audit-stream.md)) via `emitAuditEvent`:

| Action | When |
| --- | --- |
| `pat.create` | A token is created. |
| `pat.revoke` | A token is revoked (records whether by the owner or an admin). |
| `pat.use-denied` | A **proven** token (correct secret) is presented while **revoked** or **expired** — the use-after-revoke signal a SOC alerts on. |

An unknown id or a wrong secret is **not** audited (that is unauthenticated
enumeration noise, not a token misuse).

## Storage & deployment

Tokens live in the `loom-pat-tokens` Cosmos container (partition key `/id`, so
the hot resolve path is a single-partition point-read). The container is
ARM-provisioned in `platform/fiab/bicep/modules/landing-zone/cosmos.bicep` and
lazily `createIfNotExists`-ed by `cosmos-client.ts` — a from-scratch deployment
needs no extra step and **no new environment variable or Key Vault secret**
(the SHA-256 hash needs no key).

## Foundation for the developer platform

BR-PAT is the authentication foundation the rest of the developer-platform track
rides on: **BR-OPENAPI** (versioned OpenAPI surface + generated SDKs),
**BR-TERRAFORM** (`terraform-provider-loom`), and **BR-SCIM** (SCIM 2.0
provisioning) all authenticate with scoped API tokens.
