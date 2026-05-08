# Deployment provenance — `copilot-chat` Azure Function

> Owner: platform team.  Last verified: 2026-04-26 (PR #107).

## Where it lives (production)

| Field | Value |
|-------|-------|
| **Tenant** | `limitlessdata.ai` (`d1fc0498-f208-4b49-8376-beb9293acdf6`) |
| **Subscription** | `FedCiv ATU FFL - DLZ` (`363ef5d1-0e77-4594-a530-f51af23dbf8c`) |
| **Resource Group** | `rg-dlz-aiml-stack-dev` |
| **Region** | `eastus` |
| **Function App** | `func-csa-inabox-copilot-fg` |
| **Hostname** | `https://func-csa-inabox-copilot-fg.azurewebsites.net` |
| **Plan** | Linux Consumption (Y1), Python 3.12, Functions v4 |
| **Storage** | `aimldatastore` (shared with `fabric-copilot-docs-fg`, in same RG) |
| **App Insights** | `appi-csa-inabox-copilot-fg` (in same RG) |
| **Identity** | System-assigned managed identity |

## Endpoint consumed by the docs site

The widget at `docs/javascripts/copilot-chat.js` posts to:

```
https://func-csa-inabox-copilot-fg.azurewebsites.net/api/chat
```

That URL is **hardcoded in the JS** (no runtime override — see SEC-COPILOT
in `docs/javascripts/copilot-chat.js`).  Updating the backend host
requires editing that file and republishing GitHub Pages.

## Backend dependencies

| Dependency | Where it lives |
|------------|----------------|
| Azure OpenAI endpoint | `https://fgaro-mdg63bud-eastus2.cognitiveservices.azure.com/` (in same sub, `rg-dlz-aiml-stack-dev`, eastus2 region) |
| Model deployment | `gpt-5.4-nano` |
| OpenAI key | Stored as `AZURE_OPENAI_KEY` app setting (rotate via key1/key2 on the cognitive services account) |

## Hardening applied at provisioning time

- `httpsOnly = true`
- `minTlsVersion = 1.2`
- `ftpsState = Disabled`
- CORS allow-list restricted to:
  - `https://fgarofalo56.github.io` (GitHub Pages)
  - `http://localhost:8000`, `http://localhost:8080` (local mkdocs serve)
- Storage account `aimldatastore` has `allowBlobPublicAccess=false`
- Function-level `X-Copilot-Token` time-window auth (30s sliding window) gates all `/api/chat` POSTs

## What was wrong before this PR

The Function App + its backing storage account were accidentally
provisioned in the personal `House Garofalo Prod` subscription
(`743b3075-…`) under RG `rg-csa-inabox-copilot`.  Only the Azure
OpenAI endpoint it called was correctly placed in the FedCiv DLZ
subscription.

The personal-subscription resources were torn down out-of-band before
this PR.  The widget pointed at the now-defunct
`func-csa-inabox-copilot.azurewebsites.net` until the JS update in
this PR.

The new function had to take the `-fg` suffix because Azure had not
yet released the global `func-csa-inabox-copilot` hostname after the
soft-delete window on the old (personal-sub) instance.

## Re-deploy / update runbook

```bash
# 1. Authenticate to the right tenant
az login --tenant limitlessdata.ai
az account set --subscription "FedCiv ATU FFL - DLZ"

# 2. From repo root, publish code changes
cd azure-functions/copilot-chat
func azure functionapp publish func-csa-inabox-copilot-fg --python --build remote

# 3. Smoke test (token rotates every 30s)
WINDOW=$(($(date +%s)/30))
HASH=$(printf "%s:csa-copilot-2024" "$WINDOW" | sha256sum | cut -c1-16)
curl -s -X POST \
  -H "Origin: https://fgarofalo56.github.io" \
  -H "Content-Type: application/json" \
  -H "X-Copilot-Token: ${WINDOW}:${HASH}" \
  -d '{"message":"hello","history":[],"pageContext":{"url":"https://fgarofalo56.github.io/csa-inabox/","title":"smoke"}}' \
  https://func-csa-inabox-copilot-fg.azurewebsites.net/api/chat
```

## Recreate from scratch

If the resource needs to be rebuilt entirely:

```bash
DLZ=363ef5d1-0e77-4594-a530-f51af23dbf8c
RG=rg-dlz-aiml-stack-dev
LOC=eastus
ST=aimldatastore        # reuse: shared-key policy blocks new storage accounts
FUNC=func-csa-inabox-copilot-fg
AI=appi-csa-inabox-copilot-fg

az monitor app-insights component create --subscription $DLZ -g $RG -l $LOC \
  --app $AI --kind web --application-type web

az functionapp create --subscription $DLZ -g $RG -n $FUNC \
  --storage-account $ST --consumption-plan-location $LOC \
  --runtime python --runtime-version 3.12 --functions-version 4 \
  --os-type Linux --app-insights $AI \
  --app-insights-key "$(az monitor app-insights component show --subscription $DLZ -g $RG --app $AI --query instrumentationKey -o tsv)" \
  --https-only true --assign-identity '[system]'

az functionapp config set --subscription $DLZ -g $RG -n $FUNC \
  --min-tls-version 1.2 --ftps-state Disabled

az functionapp cors add --subscription $DLZ -g $RG -n $FUNC \
  --allowed-origins "https://fgarofalo56.github.io" "http://localhost:8000" "http://localhost:8080"

OAI_KEY=$(az cognitiveservices account keys list --subscription $DLZ \
  -g rg-dlz-aiml-stack-dev -n fgaro-mdg63bud-eastus2 --query key1 -o tsv)

az functionapp config appsettings set --subscription $DLZ -g $RG -n $FUNC --settings \
  "AZURE_OPENAI_ENDPOINT=https://fgaro-mdg63bud-eastus2.cognitiveservices.azure.com/" \
  "AZURE_OPENAI_KEY=$OAI_KEY" \
  "AZURE_OPENAI_DEPLOYMENT=gpt-5.4-nano" \
  "ALLOWED_ORIGINS=https://fgarofalo56.github.io,http://localhost:8000,http://localhost:8080,http://127.0.0.1:8080" \
  "SCM_DO_BUILD_DURING_DEPLOYMENT=true"

cd azure-functions/copilot-chat
func azure functionapp publish $FUNC --python --build remote
```

## Analytics pipeline (added 2026-05-06)

The Function App now writes chat content, feedback, and backlog
submissions to Cosmos DB and emits custom events to Application
Insights. See [`docs/copilot-privacy.md`](../../docs/copilot-privacy.md)
for the user-facing privacy notice.

### Cosmos DB

Provisioned via `azure-functions/copilot-chat/deploy/main.bicep` —
deployed 2026-05-06 to `cosmos-csa-inabox-copilot-fg` in **eastus2**
(eastus had AZ-redundant capacity issues; Function App stays in eastus,
~5ms cross-region latency to Cosmos):

```bash
az login --tenant limitlessdata.ai
az account set --subscription "FedCiv ATU FFL - DLZ"
az deployment group create \
  -g rg-dlz-aiml-stack-dev \
  -f azure-functions/copilot-chat/deploy/main.bicep
```

If Cosmos `eastus2` is full at the time of deploy, override:

```bash
az deployment group create \
  -g rg-dlz-aiml-stack-dev \
  -f azure-functions/copilot-chat/deploy/main.bicep \
  --parameters location=westus2
```

After the deployment finishes, set these app settings on the Function App
(replace the endpoint with the Bicep output value). **Done 2026-05-06.**

```bash
SALT=$(python -c "import secrets; print(secrets.token_urlsafe(32))")
az functionapp config appsettings set \
  --subscription 363ef5d1-0e77-4594-a530-f51af23dbf8c \
  -g rg-dlz-aiml-stack-dev \
  -n func-csa-inabox-copilot-fg \
  --settings \
    "COSMOS_ENDPOINT=https://cosmos-csa-inabox-copilot-fg.documents.azure.com:443/" \
    "COSMOS_DATABASE=copilot" \
    "COPILOT_IP_HASH_SALT=$SALT"
```

The Function App's system-assigned MI is bound to **Cosmos DB Built-in
Data Contributor** at the account scope by the Bicep, so no Cosmos key
ever lands in app settings. If `COSMOS_ENDPOINT` is unset or the role
binding is missing, the analytics calls no-op and the chat path stays
healthy.

The drain workflow's SP (`limitlessdata_deploy`,
client `95ca491e-...`, object `b9c3cc65-...`) was granted the same
Cosmos role separately:

```bash
MSYS_NO_PATHCONV=1 az cosmosdb sql role assignment create \
  --account-name cosmos-csa-inabox-copilot-fg \
  -g rg-dlz-aiml-stack-dev \
  --scope "/" \
  --principal-id "b9c3cc65-522e-49c9-ad02-914676aa5a6b" \
  --role-definition-id "00000000-0000-0000-0000-000000000002"
```

(``MSYS_NO_PATHCONV=1`` is required when the command is run from Git
Bash on Windows; otherwise the lone ``/`` scope gets path-translated.)

### Application Insights

Already provisioned at `appi-csa-inabox-copilot-fg`. The
`APPLICATIONINSIGHTS_CONNECTION_STRING` app setting is set when the
Function App is created (see Recreate-from-scratch above). Custom
events:

| Event                   | Emitted from        | Notes                                    |
|-------------------------|---------------------|------------------------------------------|
| `chat.request`          | `/api/chat`         | per turn — latency, tokens, citation count |
| `chat.feedback`         | `/api/feedback`     | per thumbs up/down                       |
| `chat.backlog_submission` | `/api/backlog`    | per user-submitted backlog item          |
| `chat.rejected`         | any endpoint        | with `reason` dimension (bad_token, rate_limit, injection, etc.) |
| `chat.error`            | `/api/chat`         | OpenAI-side failures only                |

### Backlog drain

`.github/workflows/copilot-backlog-drain.yml` runs hourly, reads up to
25 `status=open` items from `copilot.backlog`, files a GitHub Issue for
each, and flips the Cosmos row to `status=promoted` with a stamp of the
issue number. Set the repo variable `COPILOT_COSMOS_ENDPOINT` and the
secrets `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID`
for the federated identity that has Cosmos data-read on the account.

## Known gaps (still tracked)

These were called out in `temp/security-audit-2026-05-06.md` and have
Archon tasks under feature `COPILOT-ANALYTICS-2026-05-06`:

- **SEC-COPILOT H-1.** In-memory rate-limit + token budget reset on
  cold start and don't aggregate across instances on Consumption.
- **SEC-COPILOT H-2.** The 24-pattern injection regex is bypassable;
  follow-up moves input filtering to Azure AI Content Safety + adds an
  output-side HTML strip pass.
- **SEC-COPILOT H-3.** OpenAI key still in app settings — replace with
  `azure_ad_token_provider` via DefaultAzureCredential. The Bicep PR
  prepares the role binding ahead of the code switch.
- **SEC-COPILOT H-5.** `Azure/functions-action@v1` is still pinned to
  the major-version mutable tag; pin to SHA + Dependabot.
- **`fgaro-mdg63bud-eastus2`** is a personal-name AI Services account.
  Right tenant + sub, but should be re-homed to a shared account before
  the widget gains external dependencies.
