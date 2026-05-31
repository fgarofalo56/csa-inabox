# foundry-account — parity with Azure AI Foundry / Azure OpenAI account navigator

Source UI:
- Azure AI Foundry portal left rail for a project/account: https://ai.azure.com (Deployments, Connections, models)
- Azure portal — Azure OpenAI / Cognitive Services account → **Model deployments** blade
- Learn: Microsoft.CognitiveServices accounts/deployments 2024-10-01 — https://learn.microsoft.com/azure/templates/microsoft.cognitiveservices/2024-10-01/accounts/deployments
- Learn: Microsoft.MachineLearningServices workspaces/onlineEndpoints + connections — https://learn.microsoft.com/azure/templates/microsoft.machinelearningservices/workspaces/onlineendpoints

This is **parity wave 10**: a typed Fluent v9 Tree left-navigator
(`lib/components/foundry/foundry-tree.tsx` → `FoundryAccountTree`) wired into
`foundry-hub-editor.tsx` as the `leftPanel`, driven by the EXISTING cross-sub
`AzureResourcePicker` account selection. Same pattern as `ai-search-tree.tsx`
and `databricks-workspace-tree.tsx`.

## Azure / Foundry feature inventory (every capability)

The AI Foundry / Azure OpenAI account left-rail exposes:

1. **Model deployments** — list every model deployment on the account; create
   (deploy a model: pick model + version + SKU/deployment-type + capacity/TPM);
   delete; open a deployment.
2. **Available models (model catalog, account-scoped)** — the set of models
   deployable to *this* account in *its* region (what `az cognitiveservices
   account list-models` returns); each row is a deploy entry point.
3. **Connections** — the AI Foundry hub/workspace connections (AI Search,
   Storage, other AOAI, etc.).
4. **Online endpoints** — managed online endpoints on the hub workspace.
5. **Fine-tuning jobs** — submit + monitor fine-tunes.
6. **Evaluations** — run + view model/flow evaluations.
7. **Content filters / RAI policies** — author responsible-AI content-filter
   policies and attach per deployment.
8. **Prompt flow** — author/run prompt flows.

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Model deployments — list + live count | ✅ built | `GET /api/foundry/model-deployments?account=&rg=` |
| 1 | Model deployments — deploy (model dropdown from catalog + version + SKU + capacity) | ✅ built | `POST /api/foundry/model-deployments` (real ARM PUT) |
| 1 | Model deployments — delete | ✅ built | `DELETE /api/foundry/model-deployments?name=&account=&rg=` (added this wave) |
| 1 | Model deployments — open/select (highlights, switches host to Models tab) | ✅ built | `onOpenDeployment` |
| 2 | Available models — list + per-row ＋ Deploy | ✅ built | `GET /api/foundry/models-catalog?account=&rg=` |
| 3 | Connections — list + live count | ✅ built | `GET /api/foundry/connections` (hub workspace) |
| 4 | Online endpoints — list + live count + state | ✅ built | `GET /api/foundry/deployments` (hub workspace) |
| – | Filter by name (across all groups) | ✅ built | client-side filter box |
| – | Honest infra-gate when no account is configured | ⚠️ honest-gate | MessageBar names `LOOM_AOAI_ACCOUNT` / `LOOM_AOAI_RG` + the `Cognitive Services Contributor` role + the bicep module; deployments route 503 `notDeployed` |
| 5 | Fine-tuning jobs | ⚠️ honest-gate | "coming" row; naming what's missing + which surface owns it. No fake list. |
| 6 | Evaluations | ⚠️ honest-gate | "coming" row; evaluations live in the Foundry project editor (AML data-plane). |
| 7 | Content filters (RAI policies) | ⚠️ honest-gate | "coming" row; deployments already accept `raiPolicyName`, designer not wired here. |
| 8 | Prompt flow | ⚠️ honest-gate | "coming" row; authored in the dedicated AI Foundry **project** editor. |

Zero ❌. Account-scoped groups (deployments, available models) re-query when the
selected account changes; hub-scoped groups (connections, endpoints) read the
hub default. No mocks — every count + action calls a real ARM/BFF route.

## Backend per control

| Control | Route | Real backend |
|---------|-------|--------------|
| List model deployments | `GET /api/foundry/model-deployments` | ARM `GET …/Microsoft.CognitiveServices/accounts/{acct}/deployments` (2024-10-01) |
| Deploy a model | `POST /api/foundry/model-deployments` | ARM `PUT …/accounts/{acct}/deployments/{name}` — `sku.capacity` + `properties.model{format,name,version}` |
| Delete a deployment | `DELETE /api/foundry/model-deployments?name=` | ARM `DELETE …/accounts/{acct}/deployments/{name}` |
| Available models | `GET /api/foundry/models-catalog` | ARM `GET …/accounts/{acct}/models` (account list-models) |
| Connections | `GET /api/foundry/connections` | ARM `GET …/MachineLearningServices/workspaces/{hub}/connections` |
| Online endpoints | `GET /api/foundry/deployments` | ARM `GET …/workspaces/{hub}/onlineEndpoints` |

Auth: the existing `foundry-cs-client.ts` ARM credential (UAMI
`ManagedIdentityCredential` → `DefaultAzureCredential` chain), scope
`https://management.azure.com/.default`. Keys are never read or exposed by the
navigator (read-only key surface stays in the Hub editor's Keys tab).

## Verification

- `cd apps/fiab-console && pnpm build` → exit 0.
- Functional: with a minted session + a configured `LOOM_AOAI_ACCOUNT` (or a
  cross-sub account picked), the tree lists real deployments/models/connections/
  endpoints; ＋ deploys a real model (ARM PUT) and the row appears; delete
  removes it. With no account, the tree shows the honest infra-gate MessageBar.
