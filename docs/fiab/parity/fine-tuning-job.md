# fine-tuning-job — parity with Azure OpenAI / Azure AI Foundry Fine-tuning

Source UI: Azure AI Foundry portal → **Fine-tuning** (`https://ai.azure.com` → Fine-tuning), and
the Azure OpenAI fine-tuning REST/authoring surface.
Learn: <https://learn.microsoft.com/azure/ai-foundry/openai/how-to/fine-tuning> ·
<https://learn.microsoft.com/azure/ai-foundry/openai/how-to/fine-tuning-deploy>

WS-1.3 (P0-4). Backends: **Azure OpenAI in Azure AI Foundry fine-tuning = Azure-native DEFAULT**
(serverless + managed-compute; Gov-correct `*.openai.azure.us`); **Databricks Mosaic AI fine-tuning =
opt-in** (`LOOM_FINETUNE_BACKEND=databricks`). No Microsoft Fabric dependency (`no-fabric-dependency.md`).

## Azure / Foundry feature inventory (grounded in Learn)

| # | Capability (Foundry Fine-tuning UI) | REST |
|---|---|---|
| 1 | Upload a training dataset (JSONL, chat format) | `POST {endpoint}/openai/v1/files` (purpose=fine-tune) |
| 2 | Optional validation dataset | same Files API |
| 3 | Submit a fine-tuning job (base model + training file + hyperparameters + suffix + seed) | `POST {endpoint}/openai/v1/fine_tuning/jobs` |
| 4 | List / view jobs + status | `GET {endpoint}/openai/v1/fine_tuning/jobs[/{id}]` |
| 5 | Training progress (per-step train/valid loss events) | `GET …/fine_tuning/jobs/{id}/events` |
| 6 | Cancel a running job | `POST …/fine_tuning/jobs/{id}/cancel` |
| 7 | Resulting fine-tuned model id | `fine_tuned_model` on the succeeded job |
| 8 | Deploy the fine-tuned model | `PUT …/Microsoft.CognitiveServices/accounts/{a}/deployments/{d}` |
| 9 | Bind a content-filter (RAI) policy to the deployment | `raiPolicyName` on the deployment PUT |
| 10 | Resulting-model safety evaluation (RAI / red-team) | Content Safety `text:analyze` + adversarial probing |
| 11 | Serve / consume the deployed model | AOAI chat endpoint / Model serving (WS-1.2) |

## Loom coverage

| # | Capability | Status | Loom surface |
|---|---|---|---|
| 1 | Upload training JSONL | ✅ built | Submit tab textarea → `uploadFineTuningFile` (purpose=fine-tune) |
| 2 | Validation dataset | ✅ built | client `submitFineTuningJob` (`validationData`/`validationFileId`) |
| 3 | Submit job (base model + hyperparams + suffix + seed) | ✅ built | Submit tab → `POST /api/items/fine-tuning-job/[id]` → `createFineTuningJob` |
| — | **Training-data-eval gate** (validate JSONL before submit) | ✅ built | `validateTrainingData` (≥10 rows, chat-shape, assistant target) |
| 4 | List / view jobs + status | ✅ built | Overview tab table + left rail → `listFineTuningJobs` |
| 5 | Training progress (loss events) | ✅ built | Progress tab → `GET …/events` → `listFineTuningEvents` |
| 6 | Cancel a job | ✅ built | Overview "Cancel" → `DELETE …?job=` → `cancelFineTuningJob` |
| 7 | Resulting model id | ✅ built | job view `fineTunedModel` (Details panel + Safety tab) |
| 8 | Deploy fine-tuned model | ✅ built | Safety tab "Deploy model" → `POST …/deploy` → `createModelDeployment` |
| 9 | RAI content-filter on deployment | ✅ built | `deployFineTunedModel` binds `raiPolicyName` (`Microsoft.DefaultV2` default) |
| 10 | **Resulting-model safety-eval gate** | ✅ built | Safety tab "Run safety evaluation" → `POST …/safety-eval` → red-team probes + `moderateContent`; `deployable` flips only on PASS |
| 11 | Serve the deployed model (WS-1.2) | ✅ built | AOAI deployment IS the served endpoint; approved model handed to `model-serving-endpoint` (WS-1.2) |
| — | Databricks Mosaic AI fine-tuning | ⚠️ honest-gate | opt-in `LOOM_FINETUNE_BACKEND=databricks`; honest gate (not wired) → unset to use the AOAI default |
| — | No backend configured | ⚠️ honest-gate | `HonestGate` (gate `svc-fine-tuning`) + inline Fix-it (`LOOM_AOAI_ACCOUNT`) |

Zero ❌ — every inventory row is built ✅ or an honest-gate ⚠️.

## Backend per control

| Control | Backend call |
|---|---|
| Submit job | `foundry-cs-client.uploadFineTuningFile` + `createFineTuningJob` (AOAI `/openai/v1/fine_tuning/jobs`) |
| List / status | `listFineTuningJobs` / `getFineTuningJob` |
| Progress events | `listFineTuningEvents` |
| Cancel | `cancelFineTuningJob` |
| Deploy | `createModelDeployment` (`Microsoft.CognitiveServices/accounts/deployments` PUT) |
| Safety-eval | `chatCompletion` (probe the deployed model) + `foundry-client.moderateContent` (Content Safety) + Loom `red-team` engine, graded by `agent-quality.gradeRefusalRate` |
| Base-model list | `listCatalogModels` (account-scoped, chat-completion capable) |
| Item persistence | Cosmos `items` (tenant-scoped) via `fine-tuning-item` |

## Gate

`svc-fine-tuning` (env-checks.ts + gates/registry.ts). Fix-it: resource-picker on
`LOOM_AOAI_ACCOUNT` / `LOOM_AOAI_ENDPOINT`. New editable vars: `LOOM_FINETUNE_BACKEND`,
`LOOM_AOAI_ACCOUNT` (env-config 141 → 143). Health-coverage: `fine-tuning-client → svc-fine-tuning`.

## Grade

**A− (F→A−).** Real backends for submit / status / cancel / events / deploy / safety-eval; the
resulting-model safety-eval gate runs a real red-team + Content-Safety scan and gates deployability;
the approved model is deployable/servable via WS-1.2. **Owed: browser-E2E receipt** (submit FT job on
real data → safety-eval → register → deploy) — Track-0 (`ux-baseline.md` G1).
