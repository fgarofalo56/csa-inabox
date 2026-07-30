# Loom Sharing — threat model (LU-9)

Scope: the `loom-sharing` Container App (the OSS Delta Sharing reference server) and the
Marketplace publishing BFF — the **control plane**.

> ## SPLIT NOTICE — the recipient-facing data plane is NOT in this change
>
> `/api/delta-sharing/*` — the endpoint an external recipient authenticates to, and the only
> code that ever calls the reference server — was **removed from this PR** and moved to a
> follow-up (`feat/lu9-sharing-data-plane`). Four consecutive review rounds each produced a new
> exploitable finding on that one route, and the fifth iteration is not the right answer to
> that pattern.
>
> What that means for this build, concretely:
>
> * **No external party can reach the sharing server.** Its ACA ingress is `external: false`
>   in every configuration and there is now no proxy in front of it. Nothing in the Console
>   holds an HTTP client for it (`loomSharingFetch` went out with its caller).
> * **No estate data leaves the boundary on any code path in this PR.** Every route here is
>   `withSession` (reads) or `withTenantAdmin` (mutations) and touches Cosmos only.
> * **The control plane is complete and real**: publish a share, register a recipient,
>   grant / revoke, suspend, render the server's config manifest, and audit — against Cosmos
>   and a deployed Azure backend, with the tenant-admin redaction on reads.
> * The rows below marked **DATA PLANE** are therefore statements about the follow-up, kept
>   here so nothing is lost, not claims about this build.
>
> Open findings carried to the follow-up, restated in its PR body:
>
> 1. The endpoint-wide rate limit keys on `trustedClientIp`, which behind Front Door resolves
>    to the **edge node** — closer to a global ceiling than a per-caller one. Needs to key on
>    the verified principal for authenticated callers.
> 2. No live E2E: no `delta_sharing` client has ever been run against a booted server
>    (`no-vaporware.md` / ux-baseline G1). Owed before the follow-up merges.
> 3. `deltaio/delta-sharing-server:0.7.8` base-image CVEs (see §4.1).
> 4. No per-recipient rate limit.
>
> Closed in THIS change and carried forward: the round-4 **case-colliding share name**
> cross-recipient read. Share and recipient names are case-insensitive identifiers and are now
> canonical at the point of comparison AND at the point of storage
> (`lib/sharing/model.ts` `canonicalSharingName`), so two records differing only by case cannot
> coexist and no spelling of a name resolves to a record outside the caller's grants. Proven by
> a spec that fails against the unfixed code — see `lib/sharing/__tests__/name-collision.test.ts`.

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
| S1  **DATA PLANE**  **Spoofing** a recipient | Forge / replay a bearer to `/api/delta-sharing/*` | RS256 JWKS signature verification, issuer pinned to the estate tenant, audience pinned, `exp`/`nbf` with ±5 min skew, `alg` pinned (no `none`/HMAC downgrade), and the token TYPE checked — an ID token (no `scp`/`roles`, or a `nonce`) is refused, and the bare client id is not an accepted audience, so an interactive Console sign-in credential cannot be replayed here. `lib/azure/entra-bearer-verify.ts`; tests sign with a foreign key, a foreign issuer, a foreign audience, an expired token, and an ID token for a REGISTERED recipient, and assert 401 | Token theft at the recipient. Mitigated by short Entra token lifetimes + revocation in Entra. The audience must be **pinned to this API**: with only the fallback `api://<LOOM_MSAL_CLIENT_ID>` accepted and no scope pinned, any access token for the Console's own API would satisfy the audience check, so the endpoint fails **closed** (503) unless `LOOM_SHARING_AUDIENCE` (a dedicated registration, which *replaces* the fallback) or `LOOM_SHARING_SCOPE` (a scope/app role) is set — `lib/sharing/store.sharingAudiencePinned` |
| S2 | Spoofing the **server** | Console tricked into proxying to a hostile host | `LOOM_SHARING_URL` is deploy-set (bicep/env), never caller-supplied; internal FQDN inside the CAE | Compromise of the Console env |
| T1 | **Tampering** with a grant | Recipient edits its own grants | Grants live in Cosmos, written only by tenant-admin BFF routes (`withTenantAdmin`); the recipient endpoint is read-only and never writes a grant | Compromised tenant admin |
| T2 | Tampering with the server **config** | Injecting a share via a crafted name/location | Names validated `^[a-z0-9][a-z0-9_-]{0,62}$`; locations must match `abfss://…`; YAML strings escaped; a corrupt `LOOM_SHARING_SHARES_B64` **fails the boot** rather than degrading to an empty list | — |
| R1  **DATA PLANE**  **Repudiation** of a data pull | "We never downloaded that" | Every protocol call writes an `audit-log` row (`kind:'delta-sharing'`) with the recipient, the Entra principal, the share/schema/table, the source IP, and the outcome — **including denials**: the 401 for a bad/forged/expired token, the 403 for a valid token that is not a registered recipient, the 403 for a cross-recipient reach, and the 404 for a table outside the granted share. Allow rows record the share/schema/table that were actually SERVED (resolved from the share record) and the exact upstream path | Audit write is best-effort (a Cosmos hiccup must not become a data-availability incident). Deny rows are throttled in **two** independent ways so a refusal cannot be turned into a Cosmos write amplifier: a per-key 10 s window carrying `suppressedSincePrevious`, **and** a hard per-window ceiling on rows written regardless of key (20 anonymous / 40 authenticated, separate budgets so a credential-free flood cannot starve the higher-signal 403 rows). The per-key half alone was NOT sufficient: it was keyed on `x-forwarded-for`'s leftmost hop, which the caller types, so a rotating header bought one write per request — the source is now derived only from a hop we control (`lib/azure/client-ip.ts`), and the caller's own claim is recorded separately as `claimedClientIpUntrusted`. Under the ceiling, a sustained flood loses row-level detail beyond the budget; the burst count survives |
| I1  **DATA PLANE**  **Information disclosure — cross-recipient** | Recipient A requests recipient B's share | `assertShareAccess` on **every** path segment shape, before any proxy call. `app/api/delta-sharing/__tests__/protocol.test.ts` asserts 403 **and** that `loomSharingFetch` was never invoked, across all 8 protocol resources | — |
| I2  **DATA PLANE**  **Namespace enumeration** | Probing 404-vs-403 to map every share in the estate | A share that does not exist and a share that is not granted return the **identical** 403 body; `/shares` returns only the caller's shares | A granted-but-deleted share returns 404, which only a granted recipient can observe |
| I3  **DATA PLANE**  **Disclosure via signed URLs** | A leaked file URL is a bearer credential for that file | `preSignedUrlTimeoutSeconds` / `temporaryCredentialValiditySeconds` default to **900s** (upstream: 3600); every response carries `cache-control: no-store` | A URL is usable by anyone during its window — inherent to the protocol |
| I4 | Disclosure of the **server bearer** | Secret in ARM history / logs / an API response | Key Vault `secretRef` resolved by the UAMI at revision start — the value never enters the template, `az containerapp show`, or shell history. Never echoed by any route | — |
| I5 | Disclosure of the **storage credential** | Account key with full data-plane rights | Account keys are not an option: OAuth client-credentials only, secret via Key Vault, principal scoped to **Storage Blob Data Reader** on the shared container(s) | A compromised principal can read the shared container |
| D1 | **DoS** on the sharing server | Recipient floods `query` | ACA HTTP scale rule (40 concurrent/replica, ≤10 replicas); the internal ingress + IP allow-list means only the Console can generate load | No per-recipient rate limit yet — see §4 |
| D2  **DATA PLANE**  **DoS via outbound amplification** | Anonymous forged tokens with random `kid`s, each forcing a JWKS refetch from `login.microsoftonline.com` | The `kid` lookup necessarily precedes signature verification, so an unthrottled "unknown kid ⇒ refetch" rule made every forged token an outbound request we issue on the caller's behalf (20 forged tokens → 21 fetches). Now double-braked: a forced refetch requires the UNVERIFIED issuer/audience/expiry to already line up (so garbage never reaches the network path) **and** is capped at one per 60 s per process, with unknown `kid`s memoised. Same fix applied to the sibling verifier `lib/azure/openlineage-auth.ts`, which carried the identical shape | A real key rollover can 401 the first request in a 60 s window; Entra publishes rollover keys ahead of first use |
| E1  **DATA PLANE**  **Elevation** — recipient → estate | Reaching other Loom APIs with the recipient token | The recipient token authorizes only `/api/delta-sharing/*`; every other route requires a Loom session cookie (`withSession` / `withTenantAdmin`), which a recipient never has | — |
| E2 | Elevation — VNet workload → all shares | Any pod in the CAE calls the sharing server directly | Internal ingress + `consoleAllowedCidrs` IP allow-list pinning to the Console subnet, + the bearer it does not hold. `consoleAllowedCidrs` has **no default** — the deployment fails unless the operator supplies the CIDR list (or an explicit `[]`), so the network posture is a decision rather than an omission | If `[]` is passed deliberately, VNet reachability + a leaked bearer would suffice |

---

## 3. Fail-closed inventory

Every one of these is covered by a test that asserts the failure, not the success:

| State | Behaviour |
|---|---|
| No server bearer configured | The container **refuses to boot** (an unauthenticated sharing server exposes every share) |
| Storage account set, OAuth principal incomplete | The container **refuses to boot** (it would list shares it cannot read) |
| Corrupt share manifest | The container **refuses to boot** (never degrades to "no shares") |
| No estate tenant / no pinned audience **(DATA PLANE)** | Recipient endpoint returns **503**, never 401 — our misconfiguration is not the caller's authentication failure. The 503 body is generic; the remediation (env vars, bicep module, Key Vault wiring) is LOGGED, never returned, because this endpoint is reachable with no credential |
| Sharing server not deployed | **503** with the exact bicep module + env var |
| Valid token, unknown principal **(DATA PLANE)** | **403**, with no hint whether the principal is unknown or disabled |
| Valid token, ungranted share **(DATA PLANE)** | **403**, identical body to a non-existent share |

---

## 4. Known gaps (tracked, not hidden)

1. **Base image currency.** `deltaio/delta-sharing-server:0.7.8` is the newest image upstream
   publishes (2024-04-23); releases up to v1.4.1 exist on GitHub with no image or binary
   assets. Its OS/JRE layer therefore carries unpatched base CVEs. This is a primary reason the
   app is internal-only and never recipient-facing. **Follow-up:** re-base the upstream
   `/opt/docker` payload onto a currently patched Corretto 8 runtime — not done here because it
   cannot be validated without building and booting the image against a real ADLS Delta table.
2. **No per-recipient rate limit** on `/api/delta-sharing/*` — DATA PLANE, follow-up. The
   endpoint-wide limiter added in round 3 keys on `trustedClientIp`, which behind Front Door
   resolves to the EDGE NODE, so it is closer to a global ceiling than a per-caller one. The
   follow-up must key on the verified principal for authenticated callers and keep the
   source-derived ceiling only for the anonymous path.
3. **Manifest apply is an operator step.** Publishing a table takes effect on the next Container
   App revision. Surfaced honestly (`manifestPending: true`); an ARM-driven apply is the
   follow-up.
4. **Duplicate Entra verifier.** `lib/azure/openlineage-auth.ts` carries its own copy of the
   JWKS/RS256 logic; `lib/azure/entra-bearer-verify.ts` (the other copy) went out with the data
   plane. Folding them together is tracked. What is NO LONGER a gap: the JWKS-amplification
   guard in `openlineage-auth.ts` had the `__openLineageForcedJwksRefreshCountForTest` hook and
   no spec calling it — so the round-3 class sweep that claimed to close both copies of that
   shape only ever had evidence for one. It now has a mutation-verified spec of its own
   (`lib/azure/__tests__/openlineage-jwks-amplification.test.ts`).

---

## 5. Verification

```bash
# Fail-closed rendering + sovereign endpoints (no server needed)
cd apps/loom-sharing && node --test tests/entrypoint.test.mjs

# Authorization model, name canonicalisation, and the tenant-admin redaction
cd apps/fiab-console && ./node_modules/.bin/vitest run lib/sharing app/api/marketplace/sharing
```

Live, **owed by the DATA-PLANE follow-up** before it merges (`no-vaporware.md` / ux-baseline
G1): mint an Entra token for a registered recipient, run `delta_sharing.load_as_pandas`
against `https://<console>/api/delta-sharing`, and confirm (a) it returns rows for the granted
share and (b) the same token gets 403 on another recipient's share.

Live, owed by THIS change: a browser walk of Marketplace → Data shares — create a share,
register a recipient, grant, suspend, revoke, delete — plus a non-admin session confirming the
server FQDN, the `abfss://` roots and the recipient principal ids are absent from the payload.
The redaction wiring is proven at the route level by
`app/api/marketplace/sharing/__tests__/route-scope.test.ts` (mutation-verified), but that is
not a browser walk.
