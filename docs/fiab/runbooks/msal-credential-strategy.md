# MSAL credential strategy — federated-credential migration plan (S2)

**Status:** researched migration plan (PRP `loom-next-level` item S2, Workstream S).
**Decision:** **MIGRATE to a federated identity credential (FIC) — managed identity as
the client credential.** See [Decision](#decision-fic-migration-vs-stay-on-secret--s3)
for the evidence. S3 (secret auto-rotation) remains a true *fallback*, not the
expected path.
**Scope guard:** this document is the plan only. No live app registration, Key
Vault, or Container App is touched by the PR that adds this file; the live spike
in [Phase 1](#phase-1--live-spike-operator-run-commercial) is executed by the
operator/orchestrator as a follow-up.

---

## 1. Why this exists

The Console MSAL app (the Entra app registration behind Loom sign-in,
`LOOM_MSAL_CLIENT_ID`) is a confidential client that proves itself with a
**2-year client secret**, minted by the deploymentScript in
`platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep`
(`az ad app credential reset --years 2` → `az keyvault secret set --name
loom-msal-client-secret`, mirrored in `scripts/csa-loom/bootstrap-msal-app-reg.sh`).
On 2026-07-19 a drifted/expired secret broke **all** production sign-in
(AADSTS7000215) while every non-auth probe stayed green. S1 adds expiry
*detection*; this plan (S2) removes the root cause: with a FIC there is **no
standing secret to expire, rotate, leak, or drift** — the credential is the
platform-managed, short-lived managed-identity token, refreshed automatically
([Learn: certificateless authentication — security benefits](https://learn.microsoft.com/entra/msidweb/authentication/certificateless#review-security-benefits)).

## 2. How the FIC/certificateless model works (grounded)

Per Learn ["Configure an application to trust a managed identity"](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity):

1. A **federated identity credential** is added to the app registration with:
   - **issuer** = the tenant authority, `https://login.microsoftonline.com/{tenantId}/v2.0`
     (Gov: the `.us` authority — the Bicep sample derives it per-cloud from
     `environment().authentication.loginEndpoint`);
   - **subject** = the **Object (principal) ID** of the managed identity
     (case-sensitive GUID; a mismatch fails with `AADSTS70021`);
   - **audience** = `api://AzureADTokenExchange` (Commercial),
     **`api://AzureADTokenExchangeUSGov`** (Azure Government),
     `api://AzureADTokenExchangeChina` (China).
2. At token time the workload gets a **managed-identity token for that exchange
   audience** (scope `api://AzureADTokenExchange/.default`) and presents it as
   the **client assertion** (`client_assertion_type=jwt-bearer`) in place of
   `client_secret` at the Entra token endpoint. Entra validates issuer/subject
   against the FIC and issues the app token.
3. Because the assertion substitutes for the client secret at the **token
   endpoint**, it covers every confidential-client grant the Console uses —
   auth-code exchange (`acquireTokenByCode`), silent/refresh
   (`acquireTokenSilent`), on-behalf-of (`acquireTokenOnBehalfOf`), and client
   credentials — with no per-flow changes.

Key restrictions (same Learn page +
[considerations](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-considerations)):

- Only **user-assigned** managed identities can be used as the credential (the
  Console already runs as a UAMI — good).
- App registration and managed identity must be in the **same tenant**;
  cross-**tenant** resource access is supported, cross-**cloud** is **not**
  ("Token requests to other clouds will fail") — fine for Loom, each cloud
  deployment has its own tenant, UAMI, and app registration.
- Max **20 FICs** per app; FIC `name` is immutable; wildcards unsupported; a
  wrong issuer/subject/audience is accepted silently at create time and only
  fails at exchange time.
- Only RS256-signed issuer tokens are supported (Entra-issued MI tokens are).

MSAL Node supports this **expressly**: the confidential-client `clientAssertion`
config accepts "a callback function that returns an assertion string … invoked
every time MSAL needs to acquire a token", and the doc points at workload
identity federation as the intended use: "Use this mechanism to get tokens for a
downstream API using a Federated Identity Credential"
([Learn: Initialize confidential client applications in MSAL Node](https://learn.microsoft.com/entra/msal/javascript/node/initialize-confidential-client-application#configuration-basics)).
Azure Container Apps is an explicitly supported host for the pattern — it
appears in the certificateless doc's issuer table (`https://login.microsoftonline.com/{tenant-id}/v2.0`)
and deployment section ("The Managed Identity token endpoint is automatically
available inside the container")
([Learn: Configure certificateless authentication](https://learn.microsoft.com/entra/msidweb/authentication/certificateless#issuer-urls-by-azure-service)).

## 3. Current state — every secret touchpoint in this repo

| Touchpoint | File | Role under FIC |
|---|---|---|
| Confidential client singleton (`clientSecret`) | `apps/fiab-console/lib/auth/msal.ts` (`config.auth.clientSecret`) | **Replace** with `clientAssertion` callback (mode-switched) |
| Callback route gate (`no_client_secret`) | `apps/fiab-console/app/auth/callback/route.ts` (~L279-282) | Gate becomes "secret **or** FIC mode configured" |
| Sign-in route honest gate | `apps/fiab-console/app/auth/sign-in/route.ts` (~L79-87) | Same gate update |
| Setup-identity configured check | `apps/fiab-console/app/api/setup/identity/route.ts` (~L71) | Same gate update |
| Explicit-SP CLI path | `lib/auth/msal.ts` `getSpConfidentialClient()` | **Unchanged** — caller-supplied SP secret, not ours |
| Device-code public client | `lib/auth/msal.ts` `getMsalPublicClient()` | **Unchanged** — public clients carry no credential |
| Secret mint + KV write | `platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep`, `scripts/csa-loom/bootstrap-msal-app-reg.sh` | Reworked to ensure the **FIC** instead of resetting a secret (end state) |
| Container App secretRef + env | `platform/fiab/bicep/modules/admin-plane/main.bicep` (`loomMsalClientSecret` → `LOOM_MSAL_CLIENT_SECRET` secretRef) | Removed at end state (params ride the R0 bag — no new top-level params) |
| Login-health alert text | `.github/workflows/loom-ui-verify.yml` (~L122, AADSTS7000215 rotation hint) | Update remediation text post-flip |
| Gov Dataverse coupling | `.github/workflows/gov-dataverse.yml` — warns when `LOOM_DATAVERSE_CLIENT_SECRET` points at `loom-msal-client-secret` | **Blocker for secret deletion**: rehome Dataverse S2S onto its own secret (or its own FIC) first |
| IL5 params | `.github/workflows/deploy-fiab-il5.yml` (`LOOM_GOV_MSAL_CLIENT_SECRET`), `platform/fiab/bicep/params/*.bicepparam` (`loomMsalClientSecret`) | Emptied at end state |

The Console already runs as a **user-assigned managed identity**
(`LOOM_UAMI_CLIENT_ID` / `AZURE_CLIENT_ID`) — the exact identity type the FIC
scenario requires. Note the identity split under FIC: `clientId` stays the
Console MSAL app; the **UAMI** is only the assertion source (do not conflate the
`AZURE_CLIENT_ID` fallback in `msal.ts` with the app id — under FIC they are
different principals by design).

## 4. THE open question — acquiring the assertion from ACA (answered on paper; one curl to confirm live)

The spike question is not "does confidential-client FIC exist" (it does, §2);
it is: **can the ACA managed-identity endpoint issue a token whose audience is
`api://AzureADTokenExchange`?**

Evidence that it can:

- Learn's own Node.js sample for this exact scenario calls
  `ManagedIdentityCredential.getToken(["api://AzureADTokenExchange/.default"])`
  and feeds it to `ClientAssertionCredential`
  ([Learn: update your application code](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity#update-your-application-code-to-request-an-access-token)).
  Under the hood that is the same instance-metadata GET every other resource
  uses — ACA's REST endpoint takes an arbitrary Entra resource URI:
  `GET $IDENTITY_ENDPOINT?resource=<resource>&api-version=2019-08-01` +
  `X-IDENTITY-HEADER`
  ([Learn: Managed identities in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/managed-identity#connect-to-azure-services-in-app-code)).
- The certificateless doc lists **Azure Container Apps** as a supported host
  with the standard tenant issuer (§2).

**Known repo constraint:** `@azure/identity`'s `ManagedIdentityCredential`
cannot parse the ACA MI response (`expires_on` Unix-seconds string, no
`expires_in` → "Response had no expiresOn property"; memory
`csa_loom_aca_managed_identity_bug`). The repo's
`apps/fiab-console/lib/azure/aca-managed-identity.ts`
(`AcaManagedIdentityCredential`) already bypasses this with the proven raw
`2019-08-01` call and correct `expires_on` mapping — so **the assertion fetch
reuses that exact class** with scope `api://AzureADTokenExchange/.default`
(its scope→resource strip yields `resource=api://AzureADTokenExchange`). Do
NOT route the assertion through `@azure/identity`'s MI credential.

Alternative (bench only, not the plan): MSAL Node ships its own
`ManagedIdentityApplication` (App Service `2019-08-01` protocol family, with
in-memory caching)
([Learn: Use managed identity with MSAL Node](https://learn.microsoft.com/entra/msal/javascript/node/managed-identity)).
It may parse the ACA shape correctly, but it is unproven in ACA in this repo,
while `AcaManagedIdentityCredential` is proven in production — prefer the
proven transport; keep `ManagedIdentityApplication` as plan-B if the raw call
ever regresses.

**Live confirmation (Phase 1, one command inside the running container):**

```bash
# az containerapp exec -n loom-console -g <console-rg> --command bash
curl -s "$IDENTITY_ENDPOINT?resource=api://AzureADTokenExchange&api-version=2019-08-01&client_id=$AZURE_CLIENT_ID" \
  -H "X-IDENTITY-HEADER: $IDENTITY_HEADER"
# Expect HTTP 200 {access_token, expires_on, ...}; decode the JWT payload and verify:
#   aud = api://AzureADTokenExchange
#   iss = https://login.microsoftonline.com/<tenantId>/v2.0   (matches the FIC issuer)
#   oid/sub = the Console UAMI principal id                    (matches the FIC subject)
```

If this returns 200 with the right `aud`/`iss`/`sub`, the migration has zero
remaining unknowns. If it fails (`invalid_resource` or similar), the decision
flips to stay-on-secret + S3 — see [Decision](#decision-fic-migration-vs-stay-on-secret--s3).

## 5. MSAL-Node wiring (implementation sketch for the follow-up PR)

Target: `apps/fiab-console/lib/auth/msal.ts`. The change is confined to the
`Configuration.auth` block — every flow (`acquireTokenByCode`, silent, OBO,
client-credential, the login-time OBO captures, and the Cosmos cache plugin)
rides on the same singleton and needs no change.

```ts
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

/** Per-cloud token-exchange audience (Learn: workload-identity-federation-config-app-trust-managed-identity). */
function tokenExchangeAudience(): string {
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  return cloud === 'azureusgovernment'
    ? 'api://AzureADTokenExchangeUSGov'
    : 'api://AzureADTokenExchange';
}

/**
 * FIC client assertion: the Console UAMI's managed-identity token for the
 * token-exchange audience. Cached until ~5 min before expiry — Learn's WIF
 * guidance: "Make sure this function caches the token to avoid making too
 * many calls to the external provider." MSAL invokes the callback on every
 * token-endpoint round-trip (cache misses only).
 */
let _assertion: { token: string; expiresOnTimestamp: number } | null = null;
async function ficClientAssertion(): Promise<string> {
  if (_assertion && _assertion.expiresOnTimestamp - Date.now() > 5 * 60_000) {
    return _assertion.token;
  }
  const mi = new AcaManagedIdentityCredential({
    clientId: process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID,
  });
  _assertion = await mi.getToken([`${tokenExchangeAudience()}/.default`]);
  return _assertion.token;
}

const config: Configuration = {
  auth: {
    clientId: process.env.LOOM_MSAL_CLIENT_ID || process.env.AZURE_CLIENT_ID || '',
    authority: getAuthority(),
    // Mode switch (see rollout): 'fic' → assertion callback; default → secret.
    ...(msalCredentialMode() === 'fic'
      ? { clientAssertion: ficClientAssertion }
      : { clientSecret: process.env.LOOM_MSAL_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET }),
  },
  cache: { cachePlugin: cosmosTokenCachePlugin },
  system: { /* unchanged */ },
};
```

Notes for the implementer:

- The `clientAssertion` callback shape (`async (config) => string`, where
  `config` carries `clientId`/`tokenEndpoint`) is per
  [Learn: initialize-confidential-client-application](https://learn.microsoft.com/entra/msal/javascript/node/initialize-confidential-client-application#configuration-basics).
- Proposed mode env: **`LOOM_MSAL_CREDENTIAL`** (`secret` default → `fic`).
  This is a *proposal for the follow-up implementation PR*, which must register
  it per G2 (ENV_CHECKS + GATE_META + Fix-it + `registry.test.ts` parity +
  `availability` field) and ride the R0 bag for any bicep wiring. Nothing is
  added by the S2 doc PR.
- Local dev: no `IDENTITY_ENDPOINT` → `AcaManagedIdentityCredential` throws
  `CredentialUnavailableError`; keep `secret` mode for local dev (mirror of the
  certificateless doc's "keep the existing credential as a fallback during
  migration" guidance).
- Update the three secret-presence gates (§3) to accept
  `LOOM_MSAL_CREDENTIAL=fic` as "configured".
- `getSpConfidentialClient` and the device-code public client are untouched.

## 6. Rollout plan (FIC added alongside secret → flip → remove secret)

Mirrors the Learn certificateless migration steps ("add FIC alongside the
existing credential → validate → remove")
([Learn: migrate from certificates to certificateless](https://learn.microsoft.com/entra/msidweb/authentication/certificateless#migrate-from-certificates-to-certificateless-authentication)).

### Phase 1 — live spike (operator-run, Commercial)

1. Run the §4 curl inside `loom-console`; capture the decoded `aud`/`iss`/`sub`
   claims as the receipt.
2. Add the FIC to the Console MSAL app — **purely additive; the secret keeps
   working; zero login risk**:

   ```bash
   az ad app federated-credential create --id <console-msal-app-object-id> --parameters '{
     "name": "loom-console-uami-fic",
     "issuer": "https://login.microsoftonline.com/<tenantId>/v2.0",
     "subject": "<console-uami-PRINCIPAL-id>",
     "description": "Loom Console UAMI as certificateless credential (S2)",
     "audiences": ["api://AzureADTokenExchange"]
   }'
   ```

   (Graph equivalent: `POST /applications/{appObjectId}/federatedIdentityCredentials`.
   Requires Application Administrator / Cloud Application Administrator or app
   ownership — same Graph surface the app-reg deploymentScript identity already
   holds.) **subject is the UAMI's Object (principal) ID, not its client ID** —
   `AADSTS70021` if mismatched.
3. Optional bench proof before any code ships: a one-off Node script in the
   container acquiring an app token via a hand-built
   `client_assertion` POST to the token endpoint, proving the exchange
   end-to-end.

### Phase 2 — code lands behind the mode switch (default `secret`)

Implement §5 + the gate updates; ship in a normal roll. Behavior is
byte-for-byte unchanged until the flag flips.

### Phase 3 — flip to `fic` (secret still present)

1. Set `LOOM_MSAL_CREDENTIAL=fic` on `loom-console`; roll a revision.
2. Verify: interactive browser login; the minted-session probe; the
   `loom-ui-verify` login-health job; a silent-refresh cycle (sliding session);
   one OBO capture (e.g. ARM user-token store write at login). Both clouds.
3. Soak ≥ 2 weeks incl. at least one full roll + one replica restart (proves
   assertion refresh + multi-replica behavior).

### Phase 4 — remove the secret (end state)

1. **Pre-req:** rehome the Gov Dataverse S2S secretRef off
   `loom-msal-client-secret` (§3 coupling) — its own secret or its own FIC.
2. Remove `LOOM_MSAL_CLIENT_SECRET` env + the `loomMsalClientSecret` secretRef
   from `admin-plane/main.bicep` (R0 bag rules apply); empty the
   `*.bicepparam` values.
3. Change `entra-app-registration.bicep` + `bootstrap-msal-app-reg.sh` from
   `az ad app credential reset` to **ensure-the-FIC** (idempotent
   `federated-credential create`-if-absent). `SESSION_SECRET` handling stays.
4. Delete the app's password credentials:
   `az ad app credential delete --id <app-id> --key-id <keyId>`.
5. Update the `loom-ui-verify` AADSTS7000215 remediation text (rotation hint →
   FIC diagnostics: check FIC subject vs UAMI principal, MI endpoint health).
6. S1's secret-expiry monitor then shows **zero standing MSAL credentials** —
   the WS-S root cause is retired (S1 continues to watch the other tracked
   credentials).

### Rollback (any phase)

- **Phase 3 rollback (seconds):** set `LOOM_MSAL_CREDENTIAL=secret`, roll a
  revision — the KV secret is untouched until Phase 4, so this is a pure env
  flip.
- **Post-Phase-4 rollback:** re-mint a secret (the S3 rotation workflow, or
  manually: `az ad app credential reset --append --years 2` → KV
  `loom-msal-client-secret` → `az containerapp secret set` → set
  `LOOM_MSAL_CREDENTIAL=secret` → roll). The FIC can stay in place (inert when
  unused) for instant re-flip.

## 7. Per-cloud variants

| Boundary | Authority (already in `msal.ts` `authorityHost()`) | FIC issuer | FIC audience |
|---|---|---|---|
| Commercial / GCC | `login.microsoftonline.com` | `https://login.microsoftonline.com/<tenantId>/v2.0` | `api://AzureADTokenExchange` |
| Azure Government (GCC-High / DoD) | `login.microsoftonline.us` | `https://login.microsoftonline.us/<tenantId>/v2.0` | **`api://AzureADTokenExchangeUSGov`** |

Per-cloud audiences are normative in
[Learn: workload-identity-federation-config-app-trust-managed-identity](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity#important-considerations-and-restrictions);
the issuer follows the cloud's login endpoint (the Learn Bicep sample derives it
from `environment().authentication.loginEndpoint`). The `tokenExchangeAudience()`
helper (§5) keys off the same `AZURE_CLOUD` switch the authority already uses.
Cross-cloud token requests are unsupported — each cloud's UAMI federates only
with that cloud's own app registration, which is exactly Loom's topology (the
Gov deployment has its own tenant, UAMI, and Console MSAL app).

**IL5 note (design only):** IL5 runs in Azure Government (same `.us` authority
+ USGov audience row above), fully in-boundary: the assertion comes from the
in-enclave ACA MI endpoint, the exchange happens at the in-boundary `.us` token
endpoint, and the one-time FIC create is a Graph write executable from the
in-enclave runner (per the X-IL5 checklist). FIC *improves* the IL5 ATO story:
no long-lived secret material at rest in KV, in env, or in operator hands — the
"no credential rotation / no secrets to leak" properties are called out in
[Learn: certificateless — security benefits](https://learn.microsoft.com/entra/msidweb/authentication/certificateless#review-security-benefits).

## 8. Decision — FIC migration vs stay-on-secret + S3

**Recommendation: MIGRATE (FIC). Confidence: high. S3 remains the documented
fallback and the transition-window safety net.**

Evidence for:

1. **Feasibility is established, not speculative.** MSAL-Node's confidential
   client documents the `clientAssertion` callback *for the FIC scenario*
   (§2); ACA is a documented supported host with a standard tenant issuer
   (§2); per-cloud exchange audiences exist for Gov (§7).
2. **The only genuinely open sub-question is one HTTP call** (§4), and the
   documented protocol (arbitrary resource URI on the same `2019-08-01`
   endpoint) plus Learn's own Node sample for this scenario both point to
   yes. The known ACA `@azure/identity` parse bug is already solved in-repo
   by `AcaManagedIdentityCredential`, which becomes the assertion transport.
3. **It retires the entire WS-S root cause** (2-year secret expiry/drift →
   total sign-in outage), rather than automating around it: no standing
   credential, platform-managed refresh, nothing for S1 to alarm on for the
   MSAL app.
4. **Rollout risk is contained**: the FIC is additive next to the secret, the
   mode switch is a per-revision env flip, and rollback through the whole soak
   window is "flip back to secret".
5. **Ops cost goes down** vs S3, which adds a scheduled rotation workflow, a
   grace-window dance, and a standing secret that still constitutes leakable
   material and an ATO finding surface.

Residual risks (all bounded):

- ACA MI endpoint refuses the `api://` audience → **decision flips** to
  stay-on-secret + S3; Phase 1 discovers this before any code ships.
- FIC misconfig fails silently at create time (Learn warning) → the Phase 1
  bench proof + Phase 3 verification catch it while the secret path still
  works; `AADSTS70021` = subject mismatch, `AADSTS700024` = assertion
  expiry/clock skew (see the certificateless doc's troubleshooting table).
- Local dev has no MI endpoint → `secret` mode stays supported for dev
  (dev-only secret can be a low-privilege, short-lived one after Phase 4).
- The Dataverse S2S secretRef coupling blocks Phase 4 until rehomed (§6) —
  tracked as an explicit pre-req, not a surprise.

**When S3 executes instead:** only if Phase 1's curl fails on both a
consumption and a dedicated workload profile, or if the exchange is rejected in
Gov (`api://AzureADTokenExchangeUSGov`) with no Learn-documented workaround. In
that case S3's rotate-workflow is the prevention story and this document's §4
receipt is attached to the S3 PR as the negative evidence.

## References (Learn, fetched 2026-07-22)

- Configure an application to trust a managed identity (FIC setup, per-cloud
  audiences, restrictions, per-language assertion samples):
  <https://learn.microsoft.com/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity>
- Configure certificateless authentication (ACA as supported host, issuer
  table, migrate-alongside-then-remove pattern, troubleshooting):
  <https://learn.microsoft.com/entra/msidweb/authentication/certificateless>
- Initialize confidential client applications in MSAL Node (`clientAssertion`
  callback, FIC pointer):
  <https://learn.microsoft.com/entra/msal/javascript/node/initialize-confidential-client-application>
- Using certificate credentials with MSAL Node (credential taxonomy):
  <https://learn.microsoft.com/entra/msal/javascript/node/certificate-credentials>
- Use managed identity with MSAL Node (`ManagedIdentityApplication`, plan-B
  transport): <https://learn.microsoft.com/entra/msal/javascript/node/managed-identity>
- Managed identities in Azure Container Apps (REST endpoint,
  `IDENTITY_ENDPOINT` + `X-IDENTITY-HEADER`, `2019-08-01`):
  <https://learn.microsoft.com/azure/container-apps/managed-identity>
- Important considerations and restrictions for federated identity credentials
  (RS256, audience limits, region caveats):
  <https://learn.microsoft.com/entra/workload-id/workload-identity-federation-considerations>
- Workload identity federation with MSAL (assertion-caching guidance):
  <https://learn.microsoft.com/entra/msal/dotnet/acquiring-tokens/web-apps-apis/workload-identity-federation>
