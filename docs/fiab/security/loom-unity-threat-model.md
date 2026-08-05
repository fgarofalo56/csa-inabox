# Loom Unity control plane — threat model (LU-2)

**Item:** LU-2 (`PRPs/active/loom-apex` Phase C — Loom Unity, the lead security item)
**Status:** shipped with the LU-2 change set; sign-off block below.
**Scope:** the **Loom Unity control plane** — the self-hosted, **Unity-Catalog-compatible**
OSS catalog server Loom deploys as the `loom-unity` Container App
(`platform/fiab/bicep/modules/compute/loom-unity-app.bicep`, `apps/loom-unity/`), the
Console BFF that fronts it (`lib/azure/uc-backend.ts`, `lib/azure/unity-catalog-client.ts`),
and its credential-vending path. "Loom Unity" is the Loom platform name; the server speaks
the Unity Catalog REST surface but is **not** a Databricks product and is never branded as one.
**Cloud-neutral:** the tables hold for Commercial, GCC High, and IL5. Sovereign deltas are in
[§5](#5-gov--il5-delta).
**Methodology:** STRIDE per surface, with each mitigation mapped to the file that ships it.

---

## 1. The finding LU-2 closes

Before LU-2 the deployed catalog ran `server.authorization=disable`
(`docs/fiab/unity-gov.md`, pre-LU-2 §Auth; `loom-unity-app.bicep` ingress block) and the
Container Apps VNet was the **only** control. Consequences, all real:

| # | Consequence | Severity |
|---|---|---|
| F-1 | Any workload that could reach the Container Apps environment could **read** every catalog, schema, table, volume, function, model, external location, and credential name. | HIGH |
| F-2 | The same caller could **mutate** them — create/drop catalogs and schemas, repoint external locations, and **rewrite grants**, with no attribution. | HIGH |
| F-3 | Where ADLS credential vending was wired, the same anonymous caller could **mint delegation SAS** for the lake. | HIGH |
| F-4 | The vending service-principal secret was documented as an inline `az containerapp update --set-env-vars …CLIENT_SECRET=<value>` — landing a live secret in ARM deployment history and shell history. | MEDIUM |
| F-5 | Nothing distinguished "the catalog is secured" from "the catalog answers anyone": no gate, no probe, no signal. | MEDIUM |

### 1.1 The residual finding `svc-loom-unity-authz` closes

LU-2 made `authMode='entra'` the module default, but it was only *honored* when an
audience could be pinned:

```bicep
var authEnabled = authMode == 'entra' && audiencePinned   // pre-fix
```

and `loom-entrypoint.sh` mirrored the same inference (`auth=disable` whenever no
`LOOM_UNITY_ENTRA_TENANT_ID` happened to be set). So the "secure default" only
applied to callers who already passed `entraClientId` — and **no caller did**: the
catalog was deployable only out-of-band, and both real invocations
(`.github/workflows/gov-uc-purview-wire.yml`, the `az deployment group create`
line in `docs/fiab/unity-gov.md`) omitted it. The shipped default therefore still
produced F-1/F-2/F-3, with the only signal being a stderr line.

| # | Consequence | Severity | Closed by |
|---|---|---|---|
| F-6 | A deployment that omitted one parameter got the full anonymous posture while the module documented itself as "Entra ON by default". | HIGH | `authEnabled = authMode == 'entra'` — no silent downgrade; `authorizationMisconfigured` output. |
| F-7 | The container inferred `authorization=disable` from an unset env var, so the image itself had an anonymous default. | HIGH | `auth="${LOOM_UNITY_AUTH:-enable}"` — the image **fails closed** and refuses to boot when nothing can be pinned. The bicep modules never hand it that state: an Entra app registration is a Microsoft Graph object ARM cannot create, so when none exists they deploy the catalog **SEALED** — authorization on, issuer pinned, audience pinned to a per-deployment `api://…invalid` sentinel no tenant can mint, `minReplicas: 0`. Up, probes green, every caller rejected; `authorizationSealed` / `authorizationMisconfigured` report it and deploy phase 3 unseals it. See docs/fiab/unity-gov.md § "The SEALED state". |
| F-8 | The catalog is not in the push-button deploy at all, so the secured posture depends on an operator running a documented command correctly. | HIGH | **STILL OPEN.** Deploying `loom-unity` from `admin-plane/main.bicep` by default is deliberately deferred — see § 1.2; it would flip the live Gov catalog's authorization mode, which today means breaking it. |
| F-9 | `data-plane/iceberg-catalog-aca.bicep` runs the SAME image for the Iceberg REST Catalog surface and set no auth env at all. | HIGH | The same `authMode`/`entraClientId` config-bag keys, defaulting to `entra`, **plus the same SEALED fallback** so the module's own documented standalone deploy comes up rejecting rather than crash-looping. |
| F-10 | The Gov wiring workflow's own probe treated an **unauthenticated HTTP 200** as success. | MEDIUM | `gov-uc-purview-wire.yml` no longer does. The assertion is keyed to the authorization mode that run actually deployed: a 200 under `authMode=entra` FAILS the workflow; a 200 under the audited `authMode=disabled` opt-out emits a loud warning naming this finding as OPEN. Previously it was measuring reachability and calling it authorization. |

### 1.2 What is NOT closed, and why — upstream accepts only tokens it issued itself

Measured against the pinned image, both directions, transcript in
[`loom-unity-authz-proof.md`](loom-unity-authz-proof.md) (re-runnable:
`apps/loom-unity/tests/authz/authz-e2e.sh`):

* `server.authorization=enable` **is** honoured — anonymous and malformed bearers
  get 401, a valid credential gets 200 with real catalog JSON. The sealed posture
  is real: a token that is valid in every respect except the sentinel audience is
  rejected. So the fail-closed design is not theatre.
* **But** upstream `AuthDecorator` (v0.5.0 *and* v0.5.1) rejects any bearer whose
  `iss` is not the server's own `internal` issuer. A Microsoft Entra access token
  presented directly on `/api/2.1/unity-catalog/*` is answered **403
  PERMISSION_DENIED** even with a byte-exact `server.audiences` match. Clients must
  exchange it at `POST /api/1.0/unity-control/auth/tokens` and present the returned
  internal token; `AuthService.verifyPrincipal` also requires the subject to be an
  enabled Unity Catalog user.

`uc-backend.ts` `ossUcAuthHeader()` **now performs that exchange** (#2679,
`lib/azure/uc-token-exchange.ts`), and the `verifyPrincipal` half is closed too:
since #2643 the entrypoint AUTO-BINDS the Console principal's object id as an
ENABLED Unity Catalog user at boot, using the admin token the server mints for
itself (`consolePrincipalId` on `loom-unity-app.bicep`,
`.claude/rules/auto-bind-by-default.md` §5). Both blockers that made
`authMode=entra` mean "authenticated and unusable" on a federal deployment are
therefore gone, and `gov-uc-purview-wire.yml` no longer hard-codes the
`disabled` opt-out — `entra` is its default and it now REFUSES to deploy when it
cannot resolve the audience or the Console principal. What is not yet available
is live evidence: the workflow has not been re-run, so the disposition below
stays OPEN until it has. Consequences recorded honestly rather than papered over:

| # | State | Disposition |
|---|---|---|
| F-11 | `unityAuthorizationPosture()` reported the `entra` mode as `hardened: true`. It is not — the credential it describes is rejected. | Fixed: reported as **not hardened**, with the remediation naming `LOOM_UNITY_TOKEN` and the exchange endpoint. |
| F-12 | The live Gov catalog answers unauthenticated reads. | **OPEN in the estate, CLOSED in the tree.** The July-15 deployment is still live and still anonymous — its image's entrypoint defaults `LOOM_UNITY_AUTH` to `disable` and the ARM template carries no auth env at all (measured via `gov-verify-facts`, run 30972823887). What changed with #2643 is that re-running `gov-uc-purview-wire.yml` now CLOSES it instead of reproducing it: before that fix the workflow hard-coded `UNITY_AUTH_MODE=disabled`, so the redeploy the issue prescribed as the remediation would have redeployed the finding. Closing it in the estate requires that dispatch. |
| F-14 | The Console itself defaulted to `anonymous` when nothing was declared, so a deployment that forgot one variable talked to its catalog with no credential — and an un-credentialed call only *succeeds* against an open catalog. | Fixed (#2643): `resolveUnityAuthMode()` defaults to `entra`; `anonymous` must be DECLARED. An estate that cannot mint a credential now FAILS CLOSED in `ossUcAuthHeader()` rather than retrying bare. |
| F-13 | On v0.5.0, `GET /permissions/{securable}/{name}` returns **500** whenever `server.authorization=enable` (200 when disabled; `PATCH` unaffected) — upstream #1603, fixed in a v0.5.1 image Docker Hub has not published. | **OPEN** and disclosed: enabling authorization on this pinned image breaks grants **reads** — the Grants pane and the LU-4 effective-permissions resolver. The capability matrix records `grants` as `partial` on the OSS backend for this reason. |

## 2. Surface inventory (post-LU-2)

| # | Surface | Ingress | Identity model | Primary controls |
|---|---------|---------|----------------|------------------|
| S-1 | **loom-unity Container App** (Unity-Catalog-compatible REST, `:8080`) | INTERNAL ingress only + optional `ipSecurityRestrictions` allow-list pinned to the Console subnet (`consoleAllowedCidrs`) | Entra bearer, **issuer AND audience pinned** (`server.allowed-issuers` / `server.audiences`) | `loom-unity-app.bicep`, `apps/loom-unity/bin/loom-entrypoint.sh` |
| S-2 | **Console BFF → Loom Unity hop** | in-process; the BFF is the ONLY caller | Console UAMI mints `api://<client-id>/.default`, or a pre-shared server-minted token from Key Vault | `lib/azure/uc-backend.ts` (`ossUcAuthHeader`), `lib/azure/unity-catalog-client.ts` (`ucFetch`) |
| S-3 | **ADLS credential vending** (`adls.*`) | server-side only, reached through S-1 | vending service principal; secret via **Key Vault secretref** | `loom-unity-app.bicep` (`adlsClientSecretUri`, `unity-adls-client-secret`) |
| S-4 | **Catalog persistence** (PostgreSQL Flexible Server; legacy H2 file fallback) | no ingress; the Postgres store has **no public endpoint at all** (`publicNetworkAccess=Disabled` + private endpoint) | **Entra-only** (`passwordAuth=Disabled`) — no database credential exists; the JDBC driver mints a token per physical connection via `ai.limitlessdata.loom.unity.EntraPostgresAuthPlugin` (LU-1) | `data-plane/loom-unity-postgres.bicep`, `loom-unity-app.bicep`, `apps/loom-unity/java` |
| S-5 | **Posture reporting** | `/admin/health`, `/admin/gates`, `/api/catalog/unity/capabilities` | session-authenticated | `lib/admin/health-probes.ts` (`probe-loom-unity-authz`), `lib/admin/env-checks/security.ts` + `lib/gates/registry/security.ts` (`svc-loom-unity-authz`) |

## 3. STRIDE

### 3.1 S-1 — the Loom Unity server

| STRIDE | Threat / abuse case | Shipped mitigation |
|--------|---------------------|--------------------|
| **S**poofing | Any in-VNet workload calls the catalog as "nobody" and is served (F-1/F-2), or presents a token from another tenant/app | `server.authorization=enable` with `server.allowed-issuers` pinned to `https://<authority>/<tenant>/v2.0` (exact match) and `server.audiences` pinned to `api://<client-id>,<client-id>`. Both are rendered by `loom-entrypoint.sh:render_server`; the bicep default is `authMode='entra'`. |
| **T**ampering | Anonymous DDL / grant rewrites against the metastore | Same control — a mutation now requires a valid, audience-pinned Entra bearer, and the only issuer of such a bearer inside the estate is the Console managed identity. |
| **R**epudiation | Catalog changes with no attributable principal | The BFF is the single choke point (S-2): every catalog call carries the Console's credential and passes through `ucFetch`. LU-3 lands the per-call `_auditLog` + `LoomAudit_CL` rows on this same chokepoint. |
| **I**nformation disclosure | Catalog reachable beyond the Console (lateral movement from any compromised container in the environment) | Ingress stays `external: false` **and** `ipSecurityRestrictions` Allow-rules narrow it to `consoleAllowedCidrs`. ACA denies anything outside an Allow-only rule set. |
| **D**enial-of-service | Hostile in-VNet caller floods the catalog | Network narrowing (above) removes the anonymous flood path; the catalog is not internet-reachable in any posture. **LU-1 lands the scale-out half**: on the Postgres store the app runs multiple replicas behind an HTTP-concurrency scale rule (the module still forces one replica on the single-writer H2 fallback). |
| **E**levation-of-privilege | Authorization "enabled" but validating nothing — an issuer with no audience pin accepts tokens minted for unrelated resources | **Fail-closed boot**: `loom-entrypoint.sh` refuses to start (`exit 1`, explicit FATAL naming the var) when `LOOM_UNITY_AUTH=enable` without a pinned issuer or a pinned audience. A half-secured server never runs. |

### 3.2 S-2 — the Console BFF hop

| STRIDE | Threat / abuse case | Shipped mitigation |
|--------|---------------------|--------------------|
| **S**poofing | An engine or user bypasses the BFF and talks to the catalog directly | Catalog ingress is internal + IP-pinned; the Console is the only credentialed caller. Same topology the Iceberg REST catalog already enforces (`lib/azure/iceberg-catalog-client.ts`). |
| **T**ampering | Token stripped in transit | The hop is HTTPS inside the Container Apps environment; the bearer is attached per request in `ucFetch`, never cached in a shared mutable header object. |
| **R**epudiation | Un-credentialed calls silently succeed and cannot be attributed | `ossUcAuthHeader()` **fails closed**: in `token`/`entra` mode an unmintable credential throws `OssUcAuthNotConfiguredError` instead of retrying anonymously. |
| **I**nformation disclosure | Bearer / client secret leaks through config surfaces | `LOOM_UNITY_TOKEN` is deliberately **not** an `ENV_CHECKS` spec var, so it never enters `EDITABLE_ENV` / `/admin/env-config`; it is a Key Vault secretref. The Entra client secret is a Container Apps secret resolved from Key Vault by the UAMI — its value never enters the template, deployment history, or `az containerapp show`. |
| **D**enial-of-service | Token minting on every call stalls the catalog panes | Token acquisition goes through the shared `uamiArmCredential()` chain, which caches; failures surface as a structured gate rather than a hang. |
| **E**levation-of-privilege | The Console silently degrades to anonymous and the operator believes the catalog is secured | Hardening is only ever inferred from an **explicit** declaration (`LOOM_UNITY_CLIENT_ID` / `LOOM_UNITY_AUDIENCE` / `LOOM_UNITY_AUTH_MODE`) — never from `LOOM_MSAL_CLIENT_ID`, which every deployment sets. The un-declared state is reported as un-hardened, not guessed at (`unityAuthorizationPosture()`). |

### 3.3 S-3 — ADLS credential vending

| STRIDE | Threat / abuse case | Shipped mitigation |
|--------|---------------------|--------------------|
| **S**poofing | Anonymous caller mints delegation SAS for the lake (F-3) | Vending is reached only through S-1, which now requires an audience-pinned bearer. Vending itself stays **opt-in** (`adlsAccount` empty = off). |
| **I**nformation disclosure | The vending SP secret in ARM history / shell history (F-4) | The secret is passed as `adlsClientSecretUri` (a Key Vault secret URI) and wired as the Container Apps secret `unity-adls-client-secret` with `identity: unityUamiId`. There is no inline-literal path left in the module or the docs. |
| **E**levation-of-privilege | Long-lived, over-scoped storage credentials | Vended credentials are short-TTL delegation SAS scoped per table/volume/path — the upstream vending contract; Loom does not widen it. Upstream v0.5.1 also fixed credential-caching defects, which is why the image tag is pinned and bumped deliberately. |

### 3.4 S-5 — posture reporting (the anti-F-5 control)

| STRIDE | Threat / abuse case | Shipped mitigation |
|--------|---------------------|--------------------|
| **R**epudiation | "We thought it was secured" — no record of the posture | Three independent, always-on reporters: the `svc-loom-unity-authz` gate (registry + Fix-it wizard on `/admin/gates`), the `authorization` block on `GET /api/catalog/unity/capabilities`, and the `probe-loom-unity-authz` health probe. |
| **T**ampering | A stale env var claims hardening the server does not enforce | `probe-loom-unity-authz` does not read env — it sends a **deliberately unauthenticated** `GET /api/2.1/unity-catalog/catalogs`. `401/403` → pass; **`2xx` → fail with the response status as evidence**. Config drift cannot fake this. |

## 4. Residual risk (dispositioned)

| # | Residual | Disposition |
|---|----------|-------------|
| R-1 | With no `entraClientId` supplied, the module deploys with authorization OFF rather than crash-looping. | **Accepted.** An audience cannot be fabricated, and a crash-looping catalog on a push-button deploy is worse than an honest, loudly-reported gate. The container logs a SECURITY WARNING every boot, `svc-loom-unity-authz` is red with a two-half Fix-it wizard, and `probe-loom-unity-authz` fails with live evidence. |
| R-2 | `consoleAllowedCidrs` defaults to empty (internal ingress only), because the CAE infrastructure subnet CIDR is deployment-specific and cannot be derived inside the module. | **Accepted**, documented in the param description and the deploy steps. Authorization — not the network — is the primary control after LU-2. |
| R-3 | Upstream maps an authenticated principal to a **local UC user** before authorizing; a service principal that is not registered as a user is rejected. | **Accepted for LU-2** (authentication is the finding being closed). The principal→user registration + the per-securable authorization model land with LU-3/LU-4. LU-4 has SHIPPED the read side: `lib/azure/uc-effective-permissions.ts` resolves inheritance + ownership + transitive group membership over the OSS server's direct grants, so Loom can answer "what can this principal actually do here?" even though upstream has no `/effective-permissions`. It is a resolver over recorded grants, NOT an enforcement point — upstream authorization is still what enforces. |
| R-4 | `ENV_CHECKS` has no "applies only when X" predicate, so on a Commercial estate that never deploys Loom Unity the `svc-loom-unity-authz` row reads as an unset optional gate. | **Accepted**, called out in the spec comment. The live probe is the sharp verdict and passes when `LOOM_UNITY_URL` is absent. |

## 5. Gov / IL5 delta

- The Entra authority host is **derived**, never hard-coded: the module reads
  `environment().authentication.loginEndpoint`, so Azure Government pins the issuer to
  `https://login.microsoftonline.us/<tenant>/v2.0`. The entrypoint threads it through
  `LOOM_UNITY_AUTHORITY_HOST` into every derived URL.
- Everything in the chain is GA in GCC High / IL5: Container Apps (internal ingress + IP
  restrictions), user-assigned managed identity, Key Vault secretrefs, Microsoft Entra.
  No external SaaS, no public network path, no Databricks or Fabric dependency
  (`.claude/rules/no-fabric-dependency.md`).
- Air-gapped IL5: the catalog is a container on the deployment's own environment reading the
  deployment's own storage. Nothing in LU-2 adds an outbound dependency — token acquisition is
  in-boundary IMDS + the sovereign Entra endpoint.

## 6. Verification

| Control | How it is proven |
|---------|------------------|
| Fail-closed boot | `apps/loom-unity/tests/entrypoint.test.mjs` — enable-without-issuer and enable-without-audience both exit 1 with the naming FATAL. |
| Derived Entra config | Same suite — issuer/audience/authorize/token URLs derived from tenant + client id, and the sovereign authority host flowing into all of them with zero Commercial-host leakage. |
| Fail-closed BFF | `apps/fiab-console/lib/azure/__tests__/uc-authz.test.ts` — an unmintable token throws and `fetch` is never called (no anonymous fallback). |
| Credential actually reaches the wire | Same suite — real `fetch` capture asserting `authorization: Bearer <minted>` on `GET /api/2.1/unity-catalog/catalogs`. |
| No inferred hardening | Same suite — `LOOM_MSAL_CLIENT_ID` alone does not flip the mode. |
| Live posture | `probe-loom-unity-authz` on `/admin/health` (must report an unauthenticated read rejected) + the `authorization` block on `/api/catalog/unity/capabilities`. **This is the G1 browser receipt for LU-2.** |
| Bicep | `az bicep build` clean; `check-bicep-sync`, `check-bicep-param-cap`, `check-env-sync`, `check-duplicate-env`, `check-health-coverage` green. |

## 7. Review sign-off

| Field | Value |
|-------|-------|
| Threat model authored | 2026-07-28 (LU-2) |
| HIGH findings | F-1, F-2, F-3 — **mitigated** (issuer+audience-pinned Entra authorization, BFF-only credentialed access, fail-closed boot, IP-pinned ingress) |
| MEDIUM findings | F-4 — **mitigated** (Key Vault secretrefs only); F-5 — **mitigated** (gate + capability posture + live probe) |
| Residual accepted | R-1 … R-4 (§4) |
| Reviewer | _pending — record name + date at merge_ |

## 8. Cross-references

- `docs/fiab/unity-gov.md` — deployment + the honest capability matrix.
- `apps/loom-unity/README.md` — the packaged server + env-var reference.
- `docs/fiab/security/loom-next-level-threat-model.md` — the I9 program threat model this follows.
- `PRPs/active/loom-apex/research/loom-unity.md` — the audit that surfaced the finding.
- Upstream configuration reference: <https://docs.unitycatalog.io/server/auth/> and
  `unitycatalog/unitycatalog` `etc/conf/server.properties` at `v0.5.0` (the tag
  `apps/loom-unity/Dockerfile` pins) and `v0.5.1`.
