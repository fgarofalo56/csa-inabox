# Loom Unity — does `server.authorization` actually work? (measured, not asserted)

**Date:** 2026-07-29 · **Image:** `apps/loom-unity` built from
`unitycatalog/unitycatalog:v0.5.0` · **Harness:**
`apps/loom-unity/tests/authz/authz-e2e.sh` (re-runnable; Docker only, no Azure,
no Entra).

## Why this document exists

`svc-loom-unity-authz` turns Entra authorization on by default and makes the
container fail closed. For three review rounds that rested on an **assertion**:
we had evidence that anonymous and malformed-bearer calls get 401, and **no
evidence at all that a valid credential gets 200**. Both failure modes look
identical from the outside — a server that ignores `server.authorization` (the
fix is theatre) and a server that rejects everything (the fix is a permanent
outage) — so the design could not be reviewed on the evidence available.

Running it settled it. The setting is honoured, **and** the run exposed two
things no amount of source reading had caught.

## Method

A throwaway OIDC issuer (`apps/loom-unity/tests/authz/test-idp.py`: RS256, OIDC
discovery document + JWKS, mints tokens on demand) stands in for Microsoft Entra.
That substitution is faithful: `JwksOperations.loadJwkProvider` does plain OIDC
discovery against whatever string is in `server.allowed-issuers`, so the code
path a real Entra issuer takes is byte-for-byte the one exercised here. Three
containers of the same image: authorization **enabled** with a real audience,
authorization **disabled**, and the **SEALED** posture (sentinel `.invalid`
audience).

## Results — 12/12

```
== 1. boot fail-closed with nothing wired ==
  PASS  boot exit code -> 1
  PASS  boot names the missing var -> yes
== authorization ENABLED, audience pinned ==
  PASS  2 anonymous read     -> 401
  PASS  3 malformed bearer   -> 401
  PASS  4 external IdP bearer presented directly -> 403
  PASS  5 token exchange yields an internal token -> yes
  PASS  6 authenticated read with the exchanged token -> 200
  PASS  7 server-minted service token (the LOOM_UNITY_TOKEN path) -> 200
== SEALED (sentinel .invalid audience) ==
  PASS  8a anonymous read -> 401
  PASS  8b exchange of a real-audience token -> 401
== upstream #1603 — permission GET routes vs server.authorization ==
  PASS  9  GET /permissions with authz ENABLED  -> 500
  PASS  10 GET /permissions with authz DISABLED -> 200

passed: 12   failed: 0
```

Response bodies from the same run:

```
2  anonymous       401 {"error_code":"UNAUTHENTICATED","message":"No authorization found."}
3  bogus bearer    401 {"error_code":"UNAUTHENTICATED","message":"Invalid access token."}
4  Entra-shaped    403 {"error_code":"PERMISSION_DENIED","message":"Invalid access token."}
5  exchange        200 {"access_token":"…","issuedTokenType":"…access_token","tokenType":"BEARER"}
6  authenticated   200 {"catalogs":[{"name":"unity","comment":"Main catalog",…}]}
8b sealed exchange 401 {"error_code":"UNAUTHENTICATED",
                        "message":"Token verification failed: The Claim 'aud' value
                                   doesn't contain the required audience."}
9  permissions GET 500 {"error_code":"INTERNAL","message":"No authorization expression found."}
10 permissions GET 200 {"privilege_assignments":[]}
```

Rendered config the enforced container booted with (read out of the running
container, not out of the template):

```
server.env=prod
server.authorization=enable
server.allowed-issuers=http://idp:8000
server.audiences=api://loom-unity
```

## Finding 1 — `server.authorization` is honoured, in both directions

Cases 2/3 (rejected) together with cases 6/7 (accepted, real catalog JSON) are
the two-directional proof that was missing. The sealed posture is also real, not
just plausible: case 8b shows the audience check rejecting a token that is
otherwise completely valid, so a `.invalid` sentinel audience genuinely means
"up and serving nobody".

## Finding 2 — the Console's credential does not work, and cannot

Case 4 is the one that matters. The token in case 4 is signed by the pinned
issuer, has the exact audience in `server.audiences`, is unexpired, and carries
an `email` claim naming an enabled Unity Catalog user. It is answered **403
PERMISSION_DENIED**.

`server/src/main/java/io/unitycatalog/server/service/AuthDecorator.java` — line
79, **identical in v0.5.0 and v0.5.1**:

```java
if (!issuer.equals(INTERNAL)) {
  throw new AuthorizationException(ErrorCode.PERMISSION_DENIED, "Invalid access token.");
}
```

The data APIs accept **only tokens the server issued itself**. An external IdP
token is an input to the OAuth token-exchange endpoint, never a bearer for
`/api/2.1/unity-catalog/*`:

```
POST /api/1.0/unity-control/auth/tokens
  grant_type=urn:ietf:params:oauth:grant-type:token-exchange
  requested_token_type=urn:ietf:params:oauth:token-type:access_token
  subject_token_type=urn:ietf:params:oauth:token-type:id_token
  subject_token=<the Entra token>
->  { "access_token": "<internal token>", … }         # case 5
```

`apps/fiab-console/lib/azure/uc-backend.ts` `ossUcAuthHeader()` sends the Entra
token **directly**. So on a catalog deployed `authMode=entra` with a real
audience, every Console call to Loom Unity gets 403 — the exact case-4 result.
`AuthService.verifyPrincipal` adds a second requirement even once the exchange
exists: the token's `email`/`sub` must be `admin` or an **enabled Unity Catalog
user**, and a managed-identity client-credentials token carries neither an
`email` claim nor a `sub` that matches one, so the Console principal has to be
registered in the catalog first.

Consequences, stated plainly:

* `LOOM_UNITY_TOKEN` (the server-minted token in `etc/conf/token.txt`, delivered
  as a Key Vault secretref) was, at the time of this transcript, the only
  credential that worked — case 7.
* `unityAuthorizationPosture()` now reports `entra` as **not hardened**. It
  previously reported `hardened: true`, which told an operator the hop was
  secured when it was in fact broken.
* Enabling authorization on the **live Gov catalog** would not secure it, it
  would take it down. `gov-uc-purview-wire.yml` therefore deployed the explicit,
  audited `authMode=disabled` opt-out and its probe reported the finding as
  **OPEN**, until the token-exchange client landed.

> **UPDATE 2026-08-05 (#2643) — both blockers are closed in the tree.**
> The bullets above describe the state as measured; two of them are now
> superseded and it matters which.
>
> 1. **The exchange exists.** `lib/azure/uc-token-exchange.ts` (#2679) POSTs the
>    Entra token to `/api/1.0/unity-control/auth/tokens` and sends back the
>    internal token, so case 4's 403 is no longer on the Console's path.
> 2. **`verifyPrincipal` is satisfied by the platform, not the operator.** Read
>    at the tag, it resolves the subject as
>    `claims.getOrDefault(EMAIL, claim(SUBJECT))` — so an Entra **app-only**
>    token, which carries no `email`, resolves to the principal's OBJECT ID.
>    The loom-unity entrypoint now registers that object id as an ENABLED Unity
>    Catalog user at boot (`POST /api/1.0/unity-control/scim2/Users`, authorised
>    with the admin token the server mints for itself), driven by
>    `consolePrincipalId` on `loom-unity-app.bicep`. Per
>    `.claude/rules/auto-bind-by-default.md` §5 this is the platform's job, not a
>    "register a catalog user" instruction in a runbook.
>
> Consequently `gov-uc-purview-wire.yml` no longer hard-codes
> `UNITY_AUTH_MODE=disabled` — `entra` is the default and the step FAILS rather
> than falling back to an anonymous catalog when it cannot resolve the audience
> or the Console principal id. **Deploy-gated:** none of this has run against
> the live Gov catalog yet, which is why `unityAuthorizationPosture()`
> deliberately still reports `entra` as `hardened: false` and
> `probe-loom-unity-authz` remains the authority.

## Finding 3 — v0.5.0's permission GET routes 500 when authorization is on

Cases 9 and 10 are the same request against the same image, differing only in
`server.authorization`:

| `server.authorization` | `GET /api/2.1/unity-catalog/permissions/catalog/unity` |
| --- | --- |
| `enable` | **500** `{"error_code":"INTERNAL","message":"No authorization expression found."}` |
| `disable` | **200** `{"privilege_assignments":[]}` |

`PATCH` on the same path returns 200 in both states, so grant/revoke is
unaffected — reads are not. This is upstream
[issue #1603](https://github.com/unitycatalog/unitycatalog/issues/1603), fixed in
the **v0.5.1** release whose container image Docker Hub has never published
(`GET /v2/repositories/unitycatalog/unitycatalog/tags/v0.5.1` → 404). Both
`apps/loom-unity/Dockerfile` and `apps/loom-unity/README.md` already documented
the fix as "directly relevant to LU-2" — what neither said is that **turning
authorization on is what triggers the bug**.

> **UPDATE 2026-08-04 — RESOLVED without waiting for the Docker image.** The
> earlier disposition ("nothing to bump to; wait for the v0.5.1 image") checked
> only Docker Hub. The v0.5.1 **server module** *is* published on Maven Central —
> `io.unitycatalog:unitycatalog-server:0.5.1`, upstream's own released binary —
> and it carries this exact fix (the jar contains the corrected
> `PermissionService`, `UnityAccessDecorator`, `JCasbinAuthorizer`, and
> `jcasbin_auth_model.conf`). `apps/loom-unity/Dockerfile` now OVERLAYS it: the
> thin jar (only `io.unitycatalog.*` classes + the jCasbin auth-model resource,
> and it bundles the server + control model classes) is **prepended** to the
> server classpath so its classes shadow the v0.5.0 base copies as a
> self-consistent set, while every third-party dependency stays as the pinned
> base ships it. The v0.5.0 and v0.5.1 server POMs are byte-identical except their
> own version strings (zero third-party dependency changes, verified), so the
> overlay links cleanly — this is packaging (as with the Postgres driver), not a
> fork or a from-source build. `authz-e2e.sh` case 9 now asserts **200**. This is
> a Loom-side, code-fixable defect after all. Final gate: an image rebuild + the
> `authz-e2e.sh` run in Docker/CI (that harness is the live proof); a catalog
> running an image built before this overlay still 500s until redeployed.

Surfaces affected on the OSS backend once authorization is enabled:

* `/catalog/unity — Grants` (`listPermissions`);
* the LU-4 effective-permissions resolver (`uc-effective-permissions-live.ts`),
  which reads `GET /permissions/{type}/{name}` for the target **and every
  ancestor** — every node degrades to a `warnings[]` entry and the answer comes
  back empty.

The capability matrix in `uc-backend.ts` now records `grants` as `partial` on the
OSS backend for this reason, and the `effective-permissions` note carries the
same caveat.

## Reproduce

```bash
bash apps/loom-unity/tests/authz/authz-e2e.sh
# builds apps/loom-unity + the test issuer, runs 12 assertions, exits non-zero on any failure
```

## What would close each finding

| Finding | Closes when |
| --- | --- |
| 2 — Console cannot authenticate | A UC token-exchange client in `uc-backend.ts` (mint Entra token → `POST /api/1.0/unity-control/auth/tokens` → cache the internal token), **plus** registration of the Console principal as an enabled Unity Catalog user. Then `authMode=entra` can be turned on for the live estate and case 4 becomes a 200. |
| 3 — permission GET 500 | **RESOLVED 2026-08-04** by overlaying the upstream v0.5.1 `unitycatalog-server` artifact from Maven Central (`apps/loom-unity/Dockerfile`) — Docker Hub never published the v0.5.1 *image*, but the *server module* is on Maven Central and carries the fix. `authz-e2e.sh` case 9 now asserts 200. Confirm live with an image rebuild + the `authz-e2e.sh` Docker run; a catalog on an image built before the overlay still requires `server.authorization=disable` for grants reads until it is redeployed. |
