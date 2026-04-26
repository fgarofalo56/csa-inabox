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

## Known gaps (not addressed in this PR)

- **No IaC**.  Provisioning is documented above but not committed as Bicep.  A future PR could add `azure-functions/copilot-chat/deploy/main.bicep` plus a `.github/workflows/deploy-docs-chat.yml` parameterized on `${{ vars.DOCS_CHAT_SUBSCRIPTION_ID }}` so the next reviewer doesn't have to repeat this archaeology.
- **OpenAI key in app setting** instead of Key Vault reference.  Acceptable short-term because the Function App's MI was assigned at create-time; promoting to Key Vault is a follow-up.
- **`fgaro-mdg63bud-eastus2` is a personal-name AI Services account**.  It's in the right tenant and right sub, but the naming suggests it should be re-homed to a `aimlservices-shared-eastus2` (or similar) account before this docs widget gets external dependencies.
