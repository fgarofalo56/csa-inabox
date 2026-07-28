# Loom Sharing — threat model (LU-9)

Scope: the `loom-sharing` Container App (the OSS Delta Sharing reference server), the
recipient-facing endpoint `/api/delta-sharing/*`, and the Marketplace publishing BFF.

This is the only Loom surface whose **purpose** is to move estate data to a party outside the
boundary, so it is modelled before it is shipped.

---

## 1. The upstream constraint everything else follows from

The reference server authenticates with a **single global bearer token**
(`authorization.bearerToken`, `ServerConfig.scala` @ v0.7.8). It has no recipient concept and
no per-share ACL. **Any holder of that token can read every share in the server's config.**

Two consequences are structural, not configurable:

1. The server is **never** the recipient-facing endpoint. Its ACA ingress is `external: false`
   in every configuration — `loom-sharing-app.bicep` deliberately exposes no parameter to
   publish it.
2. The global bearer is a **Console→server** credential, vended from Key Vault to exactly two
   principals (the server renders it as its config, the Console presents it). It is never
   returned in any API response and never logged.

---

## 2. STRIDE

| # | Threat | Vector | Control | Residual |
|---|---|---|---|---|
| S1 | **Spoofing** a recipient | Forge / replay a bearer to `/api/delta-sharing/*` | RS256 JWKS signature verification, issuer pinned to the estate tenant, audience pinned, `exp`/`nbf` with ±5 min skew, `alg` pinned (no `none`/HMAC downgrade), and the token TYPE checked — an ID token (no `scp`/`roles`, or a `nonce`) is refused, and the bare client id is not an accepted audience, so an interactive Console sign-in credential cannot be replayed here. `lib/azure/entra-bearer-verify.ts`; tests sign with a foreign key, a foreign issuer, a foreign audience, an expired token, and an ID token for a REGISTERED recipient, and assert 401 | Token theft at the recipient. Mitigated by short Entra token lifetimes + revocation in Entra |
| S2 | Spoofing the **server** | Console tricked into proxying to a hostile host | `LOOM_SHARING_URL` is deploy-set (bicep/env), never caller-supplied; internal FQDN inside the CAE | Compromise of the Console env |
| T1 | **Tampering** with a grant | Recipient edits its own grants | Grants live in Cosmos, written only by tenant-admin BFF routes (`withTenantAdmin`); the recipient endpoint is read-only and never writes a grant | Compromised tenant admin |
| T2 | Tampering with the server **config** | Injecting a share via a crafted name/location | Names validated `^[a-z0-9][a-z0-9_-]{0,62}$`; locations must match `abfss://…`; YAML strings escaped; a corrupt `LOOM_SHARING_SHARES_B64` **fails the boot** rather than degrading to an empty list | — |
| R1 | **Repudiation** of a data pull | "We never downloaded that" | Every protocol call writes an `audit-log` row (`kind:'delta-sharing'`) with the recipient, the Entra principal, the share/schema/table, the source IP, and the outcome — **including denials**: the 401 for a bad/forged/expired token, the 403 for a valid token that is not a registered recipient, the 403 for a cross-recipient reach, and the 404 for a table outside the granted share. Allow rows record the share/schema/table that were actually SERVED (resolved from the share record) and the exact upstream path | Audit write is best-effort (a Cosmos hiccup must not become a data-availability incident). Anonymous 401 bursts from one source coalesce into one row per 10 s carrying `suppressedSincePrevious`, so a credential-free flood cannot amplify into unbounded Cosmos writes |
| I1 | **Information disclosure — cross-recipient** | Recipient A requests recipient B's share | `assertShareAccess` on **every** path segment shape, before any proxy call. `app/api/delta-sharing/__tests__/protocol.test.ts` asserts 403 **and** that `loomSharingFetch` was never invoked, across all 8 protocol resources | — |
| I2 | **Namespace enumeration** | Probing 404-vs-403 to map every share in the estate | A share that does not exist and a share that is not granted return the **identical** 403 body; `/shares` returns only the caller's shares | A granted-but-deleted share returns 404, which only a granted recipient can observe |
| I3 | **Disclosure via signed URLs** | A leaked file URL is a bearer credential for that file | `preSignedUrlTimeoutSeconds` / `temporaryCredentialValiditySeconds` default to **900s** (upstream: 3600); every response carries `cache-control: no-store` | A URL is usable by anyone during its window — inherent to the protocol |
| I4 | Disclosure of the **server bearer** | Secret in ARM history / logs / an API response | Key Vault `secretRef` resolved by the UAMI at revision start — the value never enters the template, `az containerapp show`, or shell history. Never echoed by any route | — |
| I5 | Disclosure of the **storage credential** | Account key with full data-plane rights | Account keys are not an option: OAuth client-credentials only, secret via Key Vault, principal scoped to **Storage Blob Data Reader** on the shared container(s) | A compromised principal can read the shared container |
| D1 | **DoS** on the sharing server | Recipient floods `query` | ACA HTTP scale rule (40 concurrent/replica, ≤10 replicas); the internal ingress + IP allow-list means only the Console can generate load | No per-recipient rate limit yet — see §4 |
| E1 | **Elevation** — recipient → estate | Reaching other Loom APIs with the recipient token | The recipient token authorizes only `/api/delta-sharing/*`; every other route requires a Loom session cookie (`withSession` / `withTenantAdmin`), which a recipient never has | — |
| E2 | Elevation — VNet workload → all shares | Any pod in the CAE calls the sharing server directly | Internal ingress + `consoleAllowedCidrs` IP allow-list pinning to the Console subnet, + the bearer it does not hold. `consoleAllowedCidrs` has **no default** — the deployment fails unless the operator supplies the CIDR list (or an explicit `[]`), so the network posture is a decision rather than an omission | If `[]` is passed deliberately, VNet reachability + a leaked bearer would suffice |

---

## 3. Fail-closed inventory

Every one of these is covered by a test that asserts the failure, not the success:

| State | Behaviour |
|---|---|
| No server bearer configured | The container **refuses to boot** (an unauthenticated sharing server exposes every share) |
| Storage account set, OAuth principal incomplete | The container **refuses to boot** (it would list shares it cannot read) |
| Corrupt share manifest | The container **refuses to boot** (never degrades to "no shares") |
| No estate tenant / no pinned audience | Recipient endpoint returns **503**, never 401 — our misconfiguration is not the caller's authentication failure. The 503 body is generic; the remediation (env vars, bicep module, Key Vault wiring) is LOGGED, never returned, because this endpoint is reachable with no credential |
| Sharing server not deployed | **503** with the exact bicep module + env var |
| Valid token, unknown principal | **403**, with no hint whether the principal is unknown or disabled |
| Valid token, ungranted share | **403**, identical body to a non-existent share |

---

## 4. Known gaps (tracked, not hidden)

1. **Base image currency.** `deltaio/delta-sharing-server:0.7.8` is the newest image upstream
   publishes (2024-04-23); releases up to v1.4.1 exist on GitHub with no image or binary
   assets. Its OS/JRE layer therefore carries unpatched base CVEs. This is a primary reason the
   app is internal-only and never recipient-facing. **Follow-up:** re-base the upstream
   `/opt/docker` payload onto a currently patched Corretto 8 runtime — not done here because it
   cannot be validated without building and booting the image against a real ADLS Delta table.
2. **No per-recipient rate limit** on `/api/delta-sharing/*` yet. The OpenLineage ingest's
   two-tier limiter (in-proc bucket + durable Cosmos window) is the pattern to adopt.
3. **Manifest apply is an operator step.** Publishing a table takes effect on the next Container
   App revision. Surfaced honestly (`manifestPending: true`); an ARM-driven apply is the
   follow-up.
4. **Duplicate Entra verifier.** `lib/azure/openlineage-auth.ts` predates
   `lib/azure/entra-bearer-verify.ts` and carries its own copy of the JWKS/RS256 logic. Folding
   it onto the shared verifier is tracked; it was not done in the same change as a new inbound
   surface.

---

## 5. Verification

```bash
# Fail-closed rendering + sovereign endpoints (no server needed)
cd apps/loom-sharing && node --test tests/entrypoint.test.mjs

# Authorization model + the cross-recipient boundary
cd apps/fiab-console && ./node_modules/.bin/vitest run lib/sharing app/api/delta-sharing
```

Live (per `no-vaporware.md`, still owed for this feature — see the PR body): mint an Entra
token for a registered recipient, run `delta_sharing.load_as_pandas` against
`https://<console>/api/delta-sharing`, and confirm (a) it returns rows for the granted share
and (b) the same token gets 403 on another recipient's share.
