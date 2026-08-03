# Loom Sharing — open Delta Sharing on the sovereign path (LU-9)

**What it is:** the Apache-2.0 Delta Sharing **reference server** from the protocol's own
project (`delta-io/delta-sharing`), packaged as the `loom-sharing` Container App over the
**same ADLS Gen2 Delta tables the Loom lakehouse already writes**, with per-recipient
authorization enforced by the Console.

**Why it exists:** Databricks Delta Sharing has no Azure Government endpoint, and OSS Unity
Catalog 0.5 does not implement the sharing server (upstream's roadmap marks Delta Sharing ❓).
Without this, the Marketplace "Data shares" surface has no backend at all in Gov.

No Microsoft Fabric, Power BI, or Databricks workspace is involved on this path
(`.claude/rules/no-fabric-dependency.md`).

---

## Architecture — and the one upstream fact that drives it

The reference server's **only** authorization primitive is a single global
`authorization.bearerToken` (verified against `ServerConfig.scala` on the v0.7.8 tag this image
pins). It has no concept of a recipient: **anyone holding that token sees every share the
server knows about.**

So Loom never gives that token out, and never publishes the server:

| Concern | Where it lives |
|---|---|
| Which shares exist, which tables are in them | Loom (Cosmos `sharing` container) |
| Which recipient may see which share | Loom — **and nowhere else** |
| Recipient authentication | Console BFF, Microsoft Entra bearer (JWKS, issuer + audience pinned) |
| Delta log reads, file URL signing | the reference server, reached **only** by the BFF |

```
recipient (delta-sharing client, Entra token)
        │  https://<console>/api/delta-sharing/...
        ▼
Loom Console BFF ── authenticate → resolve recipient → authorize the share in the path
        │            (401 / 403 happen HERE, before anything is proxied)
        ▼  internal ingress + IP allow-list, Console→server bearer from Key Vault
loom-sharing (OSS reference server)
        ▼  OAuth client-credentials, read-only
ADLS Gen2 Delta (the lakehouse's own lake)
```

Discovery (`/shares`, `/schemas`, `/tables`) is answered from Loom's record, filtered to the
caller. Only the data plane (`/version`, `/metadata`, `/query`, `/changes`) is proxied — and
only after the share named in the URL is confirmed to be granted to that recipient.

---

## Recipients are Entra principals, not bearer profiles

Upstream open Delta Sharing hands a recipient a `.share` profile containing a long-lived
bearer token. Loom does not: a file that is simultaneously the identity and the credential,
mailed to another organisation, cannot be revoked for one recipient without rotating it for
everyone, and it leaves no per-caller audit trail.

A Loom recipient is a set of **Entra principal ids** — the `oid` of a guest/B2B user, or the
`appid` of a federated service principal. The recipient's profile is:

```json
{
  "shareCredentialsVersion": 1,
  "endpoint": "https://<loom-console>/api/delta-sharing",
  "bearerToken": "<a Microsoft Entra access token>"
}
```

The bearer must be an **access token** for the sharing audience — an ID token minted for the
Console during an ordinary interactive sign-in is refused (`lib/azure/entra-bearer-verify.ts`
checks `scp`/`roles` and rejects the bare-client-id audience).

**The recipient credential must be pinned to this API, and there is no safe default.** Set
**one** of:

- `LOOM_SHARING_AUDIENCE` — a **dedicated** Entra app registration (App ID URI) exposed only to
  sharing recipients. When set it *replaces* the fallback, so a Console token stops being a
  sharing token at all. This is the recommended shape.
- `LOOM_SHARING_SCOPE` — a scope or app role (comma/space separated) exposed on the **Console**
  registration and consented **only** to recipient apps. Use this to avoid a second app
  registration; a Console API token without that scope is then refused.

Until one is set, `/api/delta-sharing/*` fails **closed** with `503 UNAVAILABLE`. The reason is
that the fallback audience is `api://<LOOM_MSAL_CLIENT_ID>` — the Console's *own* API — so an
unpinned endpoint would accept **any** access token minted for the Console as a valid
data-export credential, leaving the recipient-principal lookup as the only control on the path
that moves data outside the boundary. Restating `api://<clientId>` in `LOOM_SHARING_AUDIENCE`
does **not** satisfy the pin: that is the same weak configuration spelled longhand.

Tokens expire on their own, are revocable in Entra, and every call is audit-logged with the
presenting principal — allow **and** deny, including the 401 for a bad credential and the 403
for a valid token that is not a registered recipient. Allow rows record what was actually
served, resolved from the share record, not the path the caller typed.

A recipient can be **suspended** without being deleted (Data shares → Recipients → the Access
toggle, `PATCH {disabled:true}`): authentication starts failing on the next call while the
grant list and audit history survive for the investigation.

---

## Deploy

### 1. Build the image

Dispatch **`.github/workflows/deploy-loom-sharing.yml`** with `apply=build-only` (the default).
It takes the ACR firewall lease (#2603), builds the image server-side with `az acr build` — the
only mechanism that reaches a `publicNetworkAccess=Disabled` registry, and the only Gov-capable
path at all — asserts the manifest actually landed, and runs the Trivy CRITICAL scan.

> **This workflow is the producer.** Before it existed, nothing in CI built this image: the
> command below was the whole deploy path, i.e. a workstation with `az` write access
> ([#2619](https://github.com/fgarofalo56/csa-inabox/issues/2619)). `scripts/ci/check-image-producer-coverage.mjs`
> now fails the build if any `apps/*/Dockerfile` loses its producer.

> **The Trivy CRITICAL gate will fail, and that is the honest state.** The upstream payload's
> own jars carry CRITICAL findings no packaging change clears — see "Upstream image caveats"
> below. Read the printed list, then re-dispatch with `accept_upstream_cves=true` if you accept
> them for an internal-ingress-only deployment. Nothing is added to `.trivyignore`.

The equivalent by hand, if you are working outside CI:

```bash
az acr build -r <acr> -t loom-sharing:<tag> -f apps/loom-sharing/Dockerfile apps/loom-sharing
```

#### Upstream image caveats (measured 2026-08-02)

| | |
|---|---|
| **Architecture** | Every published `deltaio/delta-sharing-server` tag from **0.6.8 (2023-06-16)** onward is a single-platform **`linux/arm64/v8`** manifest; the last amd64 publication is **0.6.7**. Azure Container Apps runs amd64. `apps/loom-sharing/Dockerfile` therefore uses the upstream image as a **payload source only** (`COPY --from`, never executed on the builder) and re-bases `/opt/docker` — pure Java 8 bytecode plus a bash launcher — onto a current amd64 `eclipse-temurin:8-jre-noble`. Before that change the build died with `exec format error` on any amd64 builder. |
| **CVEs** | `trivy --ignore-unfixed --severity CRITICAL,HIGH` on `deltaio/delta-sharing-server:0.7.8`: **75 CRITICAL / 353 HIGH**, split **37 C / 216 H in the Debian 11.4 OS layer** and **38 C / 137 H inside `/opt/docker/lib`**. The re-base replaces the OS half outright — the same scan on `eclipse-temurin:8-jre-noble` (Ubuntu 24.04) reports **0 CRITICAL / 0 HIGH** before the build's `dist-upgrade` even runs. The jar half is carried verbatim and **remains**: `htrace-core4-4.1.0` (shading `jackson-databind` 2.4.0), `hadoop-common-2.10.1`, `spark-core_2.12-2.4.7`, `zookeeper-3.4.14`, `netty-3.10.6`, `avro-1.8.2` — all six verified present at identical versions in the built image, among 286 payload jars. Only an upstream rebuild clears them, and upstream has published no image since April 2024. This is the concrete reason ingress is internal-only with an IP allow-list and recipients terminate on the Console BFF. |

### 2. Create the two Key Vault secrets

```bash
# The Console→server bearer. ONE secret, held by both sides.
az keyvault secret set --vault-name <vault> -n loom-sharing-bearer --value "$(openssl rand -base64 48)"
# The read-only storage principal's client secret.
az keyvault secret set --vault-name <vault> -n loom-sharing-adls --value "<sp-secret>"
```

Grant the storage service principal **Storage Blob Data Reader** on the shared container(s)
and nothing more — this server never writes. Grant the `loom-sharing` UAMI **Key Vault
Secrets User** on the vault.

> **Why a service principal and not the managed identity?** `hadoop-azure` resolves managed
> identities through the classic IMDS endpoint (`169.254.169.254`). Container Apps does not
> serve that; it hands the identity out over `$IDENTITY_ENDPOINT`. Wiring MSI here would look
> correct in review and fail at runtime.

### 3. Deploy the Container App

> **The first deploy is deliberately manual.** `deploy-loom-sharing.yml` refuses to create this
> app, because creating it fixes two parameters that must not be guessed by a workflow:
> `sharingBearerSecretUri` (the single global Console→server bearer — its holder can read every
> published share) and `consoleAllowedCidrs` (`[]` means *no* IP pin). Once the app exists,
> dispatch the workflow with `apply=full` to rebuild + roll it; it carries both values forward
> from the running app and hard-stops rather than writing a default over either.

```bash
az deployment group create -g <admin-rg> \
  -f platform/fiab/bicep/modules/compute/loom-sharing-app.bicep \
  -p location=<region> environmentId=<cae-id> \
     acrLoginServer=<acr>.azurecr.io image=<acr>.azurecr.io/loom-sharing:<tag> \
     sharingUamiId=<uami-id> \
     sharingBearerSecretUri=https://<vault>.vault.azure.net/secrets/loom-sharing-bearer \
     adlsAccount=<lake-account> adlsClientId=<sp-client-id> \
     adlsClientSecretUri=https://<vault>.vault.azure.net/secrets/loom-sharing-adls \
     consoleAllowedCidrs='["<cae-infrastructure-subnet-cidr>"]'
```

### 4. Point the Console at it

```bash
az containerapp update -n <console> -g <admin-rg> \
  --set-env-vars LOOM_SHARING_URL=https://<sharing-fqdn> \
  --secrets loom-sharing-bearer=keyvaultref:https://<vault>.vault.azure.net/secrets/loom-sharing-bearer,identityref:<console-uami>
# then bind LOOM_SHARING_BEARER to that secret ref
```

**Then pin the recipient credential** — `LOOM_SHARING_AUDIENCE` (a dedicated app registration)
**or** `LOOM_SHARING_SCOPE` (a scope/app role on the Console registration). This is not
optional: the recipient endpoint returns `503` until one is set, and the `svc-loom-sharing`
row on `/admin/gates` reports it with a Fix-it. See "Recipient authentication" above for why
the `api://<LOOM_MSAL_CLIENT_ID>` fallback is not a pin.

---

## Publishing a share

1. **Marketplace → Data shares → Shared by me → Create share** (tenant admin).
2. Add tables — each needs its ADLS Delta root:
   `POST /api/marketplace/sharing/shares/<share>` with
   `{ "addObjects": [{ "schema": "gold", "name": "revenue", "location": "abfss://lake@st.dfs.core.usgovcloudapi.net/gold/revenue" }] }`
3. **Create a recipient** with its Entra principal id(s), then grant it the share.
4. **Apply the manifest.** `GET /api/marketplace/sharing/manifest` returns the rendered
   `shares:` YAML and its base64. Redeploy the Container App with
   `sharesManifestB64=<base64>` (or `az containerapp update --set-env-vars
   LOOM_SHARING_SHARES_B64=<base64>`).

> **Step 4 is a real seam, not a formality.** The reference server reads its share list from a
> config file at boot, so a newly added table becomes readable on the next revision — not
> instantly. The PATCH response says so (`manifestPending: true`) rather than implying the
> publish already took effect. Grants and recipients are Loom-side and DO take effect
> immediately, including revocation.

---

## Capability + honest limits

| Capability | State |
|---|---|
| `GET /shares`, `/schemas`, `/tables`, `/all-tables` | ✅ served from Loom, filtered to the caller |
| `GET .../version`, `.../metadata`, `.../changes` (CDF) | ✅ proxied after authorization |
| `POST .../query` (predicate hints, limits, versions) | ✅ proxied after authorization |
| Per-recipient scoping + immediate revocation | ✅ Loom-side (the server cannot do it) |
| Entra recipient authentication | ✅ JWKS, issuer + audience pinned, fail-closed |
| Per-call audit (allow and deny) | ✅ `audit-log`, `kind: 'delta-sharing'` |
| Publishing a table takes effect instantly | ⚠️ no — needs the manifest apply above |
| Cross-boundary recipients reaching the Console | ⚠️ requires the Console to be reachable from the recipient's network (Front Door / APIM). Loom does not open the sharing server itself. |
| Sharing a table Loom cannot read | ❌ the storage principal needs read on the container |

---

## Related

- `apps/loom-sharing/` — the packaged image + entrypoint tests
- `platform/fiab/bicep/modules/compute/loom-sharing-app.bicep`
- `docs/fiab/security/loom-sharing-threat-model.md`
- `docs/fiab/unity-gov.md` — the sibling Loom Unity (metastore) path
- `THIRD_PARTY_LICENSES.md` — the LIC0 NOTICE row for `deltaio/delta-sharing-server`
