# aoai-deploy-readiness — AOAI + AI Foundry + models, on-by-default deploy wiring

Source UI: Azure AI Foundry portal (Deployments) — https://ai.azure.com ·
Azure OpenAI Studio · the Loom Copilot / data-agent / AI-functions surfaces.
PRP: `docs/fiab/prp/deploy-readiness-100pct.md` (gap #6).

## What changed (deploy-readiness)

The AOAI provisioning module, RBAC, and env outputs already existed and were
correct. The default deploy was broken only because `agentFoundryEnabled`
defaulted **false** and was absent from the standard boundary bicepparam files,
so a fresh deploy provisioned **no** AOAI account and every Copilot / data-agent
/ AI-functions surface honest-gated. This change makes AOAI **on by default
(opt-out)** and fixes the existing-account + Spark-RBAC + private-endpoint wiring.

| Lever | Before | After |
|---|---|---|
| `agentFoundryEnabled` default (`main.bicep`, `admin-plane/main.bicep`) | `false` | **`true`** (opt-out) |
| Boundary bicepparams (`commercial/gcc/gcc-high/il5`) | flag absent | `agentFoundryEnabled = true` |
| Chat model (`foundry-project.bicep`) | `gpt-4.1-mini` | **`gpt-4o` `2024-11-20` GlobalStandard** |
| Existing-account env (Gap A) | only `LOOM_AOAI_ACCOUNT` | endpoint + chat + embed deployment all wired |
| Spark MSI RBAC (Gap B) | skipped (output didn't include agentFoundry account) | granted on the real account |
| Private endpoint (Gap C) | none (public-only or unreachable in Gov) | PE + privatelink.openai/cognitiveservices in non-Commercial |

## LOOM_AOAI_* / LOOM_FOUNDRY_* env → bicep source

All wired in `platform/fiab/bicep/modules/admin-plane/main.bicep` (Console
Container App env list). Precedence: dedicated **agentFoundry** account (default)
→ shared Foundry **hub** → **reused existing** account.

| Env var | Source (default agentFoundry path) | Existing-account path (Gap A) |
|---|---|---|
| `LOOM_AOAI_ENDPOINT` | `agentFoundry.outputs.aoaiEndpoint` | `byoFoundryEndpoint` (derived from `existingFoundryAccountName`) |
| `LOOM_AOAI_DEPLOYMENT` | `agentFoundry.outputs.chatDeployment` (`chat` = gpt-4o) | `byoFoundryChatDeployment` (`EXISTING_AOAI_CHAT_DEPLOYMENT`) |
| `LOOM_AOAI_CHAT_DEPLOYMENT` | `agentFoundry.outputs.chatDeployment` | `byoFoundryChatDeployment` |
| `LOOM_AOAI_EMBED_DEPLOYMENT` | `agentFoundry.outputs.embedDeployment` | `byoFoundryEmbedDeployment` (`EXISTING_AOAI_EMBED_DEPLOYMENT`) |
| `LOOM_AOAI_COMPLETION_DEPLOYMENT` | `loomAoaiCompletionDeployment` or module output | — (falls back to chat) |
| `LOOM_AZURE_OPENAI_ENDPOINT` | `agentFoundry.outputs.aoaiEndpoint` | `byoFoundryEndpoint` |
| `LOOM_FOUNDRY_PROJECT_ENDPOINT` | `agentFoundry.outputs.projectEndpoint` | (hub fallback) |
| `LOOM_FOUNDRY_PROJECT_ID/_NAME` | `agentFoundry.outputs.projectId/projectNameOut` | — |
| `LOOM_AOAI_ACCOUNT` | `agentFoundry` account | `existingFoundryAccountName` |
| `LOOM_AOAI_API_VERSION` / `_AUDIENCE` / `_EVALS_*` / `_FT_*` | cloud-invariant params / `environment()` | same |

## RBAC (`foundry-project.bicep` + `aoai-spark-rbac.bicep`)

| Principal | Role | GUID | Scope |
|---|---|---|---|
| Console UAMI | Azure AI Developer | `64702f94-c441-49e6-a78b-ef80e0188fee` | account |
| Console UAMI | Cognitive Services User | `a97b65f3-24c7-4388-baec-2e87135dc908` | account |
| Console UAMI | Cognitive Services OpenAI User | `5e0bd9bd-7b93-4f28-af87-19fc36ad61bd` | account |
| MAF UAMI (Gov) | Cognitive Services OpenAI User | `5e0bd9bd-…` | account |
| Synapse workspace MSI (Gap B) | Cognitive Services OpenAI User | `5e0bd9bd-…` | account |
| Databricks Access Connector MSI (Gap B) | Cognitive Services OpenAI User | `5e0bd9bd-…` | account |

All three GUIDs validated against `az role definition list`.

## Private endpoint / DNS (Gap C)

`foundry-project.bicep` creates `pe-aifndry-loom-<region>` (groupId `account`) +
a `privateDnsZoneGroups` binding **privatelink.openai** and
**privatelink.cognitiveservices** when a PE subnet is supplied. The admin-plane
invocation passes `network.outputs.privateEndpointsSubnetId` +
`privateDnsZoneIds.openai`/`.cognitiveservices` **only for non-Commercial
boundaries** (which set `publicNetworkAccess=false`); Commercial keeps public
access on and passes no subnet, so day-one works without VNet plumbing.

## Scan-and-choose (existing / new / disable + recommendation)

- **CLI** (`scripts/csa-loom/discover-services.sh` `scan_aoai`): lists
  AIServices/OpenAI accounts + their model deployments, recommends **reuse**
  when a gpt-4o-class chat + an embeddings deployment already exist (avoids a
  duplicate model + its cost), else **provision-new**. Emits `EXISTING_AOAI*`
  + `EXISTING_AOAI_CHAT_DEPLOYMENT` / `EXISTING_AOAI_EMBED_DEPLOYMENT`.
- **CLI wizard** (`scripts/csa-loom/byo-wizard.sh`): the foundry row's enabled
  flag is now `agentFoundryEnabled`; non-interactive default is **provision-new**
  (everything-ON opt-out); reuse discovers the chat/embed deployment names; gate
  prints the exact `agentFoundryEnabled = false` opt-out line.
- **Setup Wizard** (`app/api/setup/existing-aoai/route.ts`): session-gated
  Resource-Graph + ARM scan of AIServices accounts + deployments, returns
  `recommendation` (reuse/new) + per-account chat/embed classification. This is
  the real data backend the wizard's AOAI card consumes (the card UI lives in
  the Setup Wizard pane, owned by the wizard-scaffolding domain).

## Bootstrap safety-net

`.github/workflows/csa-loom-post-deploy-bootstrap.yml` verifies the
`aifndry-loom-<region>` account + a gpt-4o-class chat deployment exist, and
**re-grants** the three Console UAMI inference roles + the Synapse Spark MSI role
(idempotent) so a partial deploy self-heals. If the account is missing entirely
it emits a `::warning::` with the exact remediation (re-run with
`agentFoundryEnabled=true`) — no silent pass (per `no-vaporware.md`).

## Honest gates (unchanged — kept)

- `app/api/copilot/status/route.ts` — `NoAoaiDeploymentError` remediation.
- `app/api/ai-functions/route.ts` — `missing: LOOM_AOAI_DEPLOYMENT`, 501.
- `app/api/data-agent/run-steps/route.ts` — AOAI-not-configured gate.

These fire only when AOAI is explicitly disabled (`agentFoundryEnabled=false`)
or not yet wired — never on the default deploy.

## Acceptance

Clean deploy with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset and no `EXISTING_AOAI`:
`agentFoundryEnabled=true` → `aifndry-loom-<region>` + `chat` (gpt-4o) +
`text-embedding-ada-002` provisioned, Console UAMI granted the three roles →
`/api/copilot/status` `configured:true`, `ai-functions` + `data-agent` no longer
`not_configured`. Azure-native, no Microsoft Fabric dependency.
