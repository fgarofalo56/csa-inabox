# copilot-maf — parity with the Foundry orchestration tier (GCC-High / IL5)

Source UI / contract: the existing cross-item Copilot — `/copilot-loom` surface,
`POST /api/copilot/orchestrate` SSE contract, and the `OrchestratorStep`
transcript shape in `apps/fiab-console/lib/azure/copilot-orchestrator.ts`.

This is not a new end-user surface; it is a **second backend tier** for the SAME
Copilot. In Azure Government boundaries (GCC-High / IL5) the orchestration is
served by the `loom-copilot-maf` Container App against **Gov AOAI direct**
instead of the AI Foundry hub/Agent Service. The user-facing experience, the
streamed steps, the tool set, and the session store are unchanged.

## Why the Foundry tier needs a Gov alternative

| Foundry-tier dependency (Commercial path)                | GCC-High / IL5 reality                                                        |
|----------------------------------------------------------|------------------------------------------------------------------------------|
| AOAI discovery via Foundry hub `listConnections()`       | Hub is often `kind=Default` (classic AML); `/connections` behaves differently |
| Foundry Agent Service `*.services.ai.azure.com`          | No confirmed Azure Government host                                            |
| AOAI token audience `cognitiveservices.azure.com`        | Must be `cognitiveservices.azure.us`                                          |
| AOAI data plane `*.openai.azure.com`                     | Must be `*.openai.azure.us`                                                   |

Azure OpenAI itself **is** IL5-authorized (FedRAMP High, DoD IL4/IL5/IL6), so the
MAF tier calls it directly and skips both Foundry paths.

## Per-cloud routing (tier selection)

| Cloud      | `isGovCloud()` | `LOOM_MAF_ENDPOINT` set | Orchestration tier used                  |
|------------|----------------|-------------------------|------------------------------------------|
| Commercial | false          | (ignored)               | Foundry tier (`resolveAoaiTarget`)       |
| GCC        | false          | (ignored)               | Foundry tier                             |
| GCC-High   | true           | yes                     | **MAF tier** (`orchestrateViaMaf`)       |
| IL5        | true           | yes                     | **MAF tier**                             |
| GCC-High / IL5 | true       | unset (not deployed)    | Foundry tier (honest fallback)           |

`LOOM_MAF_ENDPOINT` is only set when `platform/fiab/bicep/modules/copilot/maf.bicep`
actually deploys, so the route never engages a tier that isn't running.

## Contract parity (built ✅ / honest-gate ⚠️ / MISSING ❌)

| Capability                                | Foundry tier            | MAF tier                                                       | Status |
|-------------------------------------------|-------------------------|----------------------------------------------------------------|--------|
| `OrchestratorStep` discriminated union    | thought/tool_call/tool_result/final/error | identical (`apps/copilot-maf/src/types.ts`)  | ✅ |
| SSE wire format (`event: step` / `done`)  | yes                     | identical                                                      | ✅ |
| System prompt / agent voice               | `SYSTEM_PROMPT`         | verbatim copy                                                  | ✅ |
| Iterate→call-tools→final loop             | yes                     | yes (`agent-loop.ts`)                                          | ✅ |
| Usage accounting (tokens, calls)          | yes                     | yes                                                            | ✅ |
| Reasoning-model temperature retry         | yes                     | yes (`aoai.ts` `isUnsupportedSamplingParam`)                   | ✅ |
| Tool set (25+ tools)                      | in-process registry     | fetched from Console internal `/tools` (same registry)         | ✅ |
| Tool dispatch + OBO + per-user ownership  | in-process handler      | delegated to Console internal invoke (same handler + `x-user-oid`) | ✅ |
| Cosmos session persistence                | `persistStep`           | same — `orchestrateViaMaf` persists each re-yielded step       | ✅ |
| AOAI completion                           | hub-discovered endpoint | `LOOM_AOAI_ENDPOINT` (Gov AOAI direct)                         | ✅ |
| AOAI not provisioned                      | `NoAoaiDeploymentError` | honest error step naming `LOOM_AOAI_ENDPOINT`/`LOOM_AOAI_DEPLOYMENT` | ⚠️ |

Zero ❌. The single ⚠️ is the honest infra gate required by `no-vaporware.md`
(when no Gov AOAI deployment is wired, the MAF app returns a precise error step
rather than fabricating a completion).

## Backend per control

| Control / step            | Backend                                                                       |
|---------------------------|-------------------------------------------------------------------------------|
| `POST /orchestrate`       | `loom-copilot-maf` Container App (`apps/copilot-maf`)                          |
| AOAI completion           | `https://<acct>.openai.azure.us/openai/deployments/<dep>/chat/completions`, token aud `cognitiveservices.azure.us` |
| Tool schemas              | Console `GET /api/internal/copilot/tools` (token-gated)                        |
| Tool execution            | Console `POST /api/internal/copilot/tools/<name>/invoke` (token-gated, `x-user-oid`) → the real Azure/Cosmos handler |
| Session persistence       | shared Cosmos `copilot-sessions` container (PK `/sessionId`)                   |

## No-Fabric / no-vaporware compliance

- No Fabric / Power BI host is on the default path. Tool handlers (which may use
  Fabric only when explicitly opted in) run in the Console exactly as before.
- The MAF app calls only Gov AOAI + the Console internal endpoints — all real.
- Bicep deploys the app, UAMI, AOAI role grant, and wires `LOOM_MAF_ENDPOINT` +
  `LOOM_INTERNAL_TOKEN`; the image is built by the `build-fiab-images*` and
  `full-app-deploy-commercial` matrices. AcrPull is granted to every
  `uami-loom-*` identity (covers `uami-loom-maf`).

## Verification

- `lib/azure/__tests__/copilot-maf-routing.test.ts` — with the cloud forced to
  GCC-High and `LOOM_MAF_ENDPOINT` set, `orchestrate()` routes to the MAF app,
  re-yields the same transcript shape, and never touches Foundry-hub discovery;
  unreachable MAF yields an error step (not a throw); unset endpoint falls back.
- `lib/auth/__tests__/internal-token.test.ts` — the internal-token gate fails
  closed and is constant-time.
- `apps/copilot-maf` + the touched Console files typecheck clean.
- Bicep `az bicep build` clean for `maf.bicep`, `identity.bicep`, and
  `admin-plane/main.bicep`.
