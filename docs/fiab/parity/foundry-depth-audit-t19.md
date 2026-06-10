# AI Foundry depth (audit-t19) — evals ops + fine-tuning + playgrounds

Source UI: https://ai.azure.com (Evaluation, Fine-tuning, Playgrounds) + Azure
OpenAI data-plane reference (preview + v1). Companion to
`foundry-evaluations.md` — this doc records the audit-t19 closeout of the 11
missing evals operations, fine-tuning job monitoring, and the 7 modality
playgrounds.

## Evals — the 11 previously-MISSING operations

| # | Operation | Loom coverage | Backend |
|---|-----------|---------------|---------|
| A6 | Delete eval | ✅ EvaluationsPanel row → Delete | `DELETE /api/foundry/evaluations?evalId=` → `deleteEval` (DELETE `/openai/v1/evals/{id}`) |
| A7 | Eval detail view | ✅ row → Detail (schema + criteria) | `GET …?evalId=&detail=1` → `getEval` |
| B5 | Additional graders (text_similarity) | ✅ CreateEvalDialog grader kind | `testing_criteria type=text_similarity` (bleu/meteor/rouge_l/cosine) |
| B6 | Multiple criteria in dialog | ✅ "+ Add another grader" | array of `testing_criteria` |
| B7 | Risk & safety evaluators | ✅ "Risk & safety" grader (RAI dims) | `label_model` graders for groundedness/relevance/coherence/fluency/content_harm/jailbreak |
| B8 | Editable data-source schema | ✅ add/remove typed fields | `data_source_config.item_schema.properties` |
| C4 | Start a run | ✅ StartRunDialog | `POST /api/foundry/evaluations/runs` → `createEvalRun` (completions data_source) |
| C5 | JSONL upload | ✅ DatasetPicker (upload or pick) | `POST /api/foundry/files` multipart → `uploadFile` |
| C6 | Per-row results | ✅ run → Results table | `GET …/runs/output` → `getEvalRunOutputItems` (`output_items`) |
| C7 | Cancel / delete run | ✅ run actions | `POST …/runs/cancel` (`cancelEvalRun`), `DELETE …/runs` (`deleteEvalRun`) |
| C8 | Metric charts | ✅ inline pass-rate bar per run | `result_counts` rendered as a 0-dep stacked bar (passed/failed/errored) |

## Fine-tuning — job monitoring (NEW)

| Capability | Loom coverage | Backend |
|------------|---------------|---------|
| Submit a job | ✅ New-fine-tune dialog (base model, dataset upload, n_epochs/batch/lr) | `POST /api/foundry/fine-tuning` → `createFineTuningJob` |
| Jobs list + status | ✅ FineTuningPanel table (status badge, trained tokens, fine-tuned model) | `GET /api/foundry/fine-tuning` → `listFineTuningJobs` |
| Monitor (events) | ✅ job → Monitor → event log | `GET …/fine-tuning/detail` → `getFineTuningJobEvents` |
| Checkpoints | ✅ checkpoints table | `listFineTuningCheckpoints` |
| Cancel | ✅ row/detail Cancel | `POST …/fine-tuning/cancel` → `cancelFineTuningJob` |
| Honest gate | ✅ unsupported model/region → MessageBar with remediation | route maps 400/404 → `notDeployed` + hint |

## Playgrounds — 7 of 8 wired from deep-link to real execution

| Playground | Loom coverage | Backend |
|------------|---------------|---------|
| Chat | ✅ (pre-existing) | `POST /api/foundry/chat` |
| Images | ✅ ImagesPlaygroundPanel | `POST /api/foundry/images` → `generateImage` |
| Audio (Whisper) | ✅ AudioPlaygroundPanel | `POST /api/foundry/audio` → `transcribeAudio` |
| Speech (TTS) | ✅ SpeechPlaygroundPanel (play + download) | `POST /api/foundry/speech` → `synthesizeSpeech` |
| Completions | ✅ CompletionsPlaygroundPanel | `POST /api/foundry/completions` → `textCompletion` |
| Reasoning (o-series) | ✅ ReasoningPlaygroundPanel (reasoning_effort) | `POST /api/foundry/reasoning` → `reasoningCompletion` |
| Assistants | ✅ AssistantsPlaygroundPanel (create→thread→run) | `POST /api/foundry/assistants` + `/assistants/run` |
| Real-time Audio | ⚠️ honest gate — WebSocket cannot proxy through the Next.js BFF; deployment mgmt + connection snippet + Foundry deep-link | n/a (live session runs in Foundry) |

Each playground gates honestly via the shared `DeploymentSelect` when no model
of that modality is deployed (no errors, no fake data) per `no-vaporware.md`.

## Per-cloud

The data-plane host is derived per sovereign boundary from `environment()` /
`cogScope()` — cloud-invariant code. Two modalities are unavailable in Azure US
Government and are short-circuited **before any HTTP call** by
`govModalityGate()`: DALL-E image generation and gpt-realtime. Everything else
(chat, completions, Whisper, TTS, evals, fine-tuning, assistants) targets the
same `*.openai.azure.us` endpoints used on Commercial.

## Bicep sync

`LOOM_AOAI_EVALS_API_VERSION` (default `preview`) and `LOOM_AOAI_FT_API_VERSION`
(default `2024-10-21`) params + Console container-app env wiring added to
`platform/fiab/bicep/modules/admin-plane/main.bicep`. No new Azure resource or
RBAC grant — all calls use the existing AOAI data-plane + the Console UAMI's
`Cognitive Services Contributor` / `Cognitive Services OpenAI User` grants.

## Verification

`pnpm vitest run lib/azure/__tests__/foundry-cs-evals-ft.test.ts` — 8 green
(eval run lifecycle, output-item mapping, cancel, file upload, fine-tuning
list/create, image gen, gov gate). tsc clean on touched files (only the
project-wide makeStyles numeric-literal noise remains). Live E2E: submit a
fine-tuning job → monitor in the Fine-tuning panel; create an eval → start a
run with a JSONL dataset → watch the pass-rate bar + per-row results.
