# global-copilot-content-safety — parity with Azure AI Content Safety

Source UI / API:
- Azure AI Content Safety — Prompt Shields: https://learn.microsoft.com/azure/ai-services/content-safety/concepts/jailbreak-detection
- Azure AI Content Safety — Analyze text: https://learn.microsoft.com/azure/ai-services/content-safety/quickstart-text
- Foundry default content filter severity model (Hate/SelfHarm/Sexual/Violence, severity 0/2/4/6)

This surface is not a single editor — it is a **cross-cutting moderation
pipeline** wired into every copilot persona (Console agent copilot, in-product
Help copilot, and the GitHub-Pages chat Function) so that no persona response
bypasses Content Safety.

## Azure / Content Safety feature inventory

| Capability | Content Safety API |
|---|---|
| Prompt-injection / jailbreak detection on user input | `POST /contentsafety/text:shieldPrompt?api-version=2024-09-01` → `userPromptAnalysis.attackDetected` |
| Harm-category severity on user input | `POST /contentsafety/text:analyze` → `categoriesAnalysis[]` (Hate/SelfHarm/Sexual/Violence) |
| Harm-category severity on model output | `POST /contentsafety/text:analyze` on the completion |
| Severity threshold (Medium = 4) matching the Foundry portal default filter | client-side gate on `severity >= 4` |
| Token-auth (Entra) via Cognitive Services User | `cognitiveservices.azure.com/.default` scope |
| Sovereign-cloud scope (GCC-High / IL5) | `cogScope()` returns `cognitiveservices.azure.us/.default` |

## Loom coverage

| Capability | Status | Where |
|---|---|---|
| Input Prompt Shields (every persona) | ✅ | `shieldPrompt()` (TS) / `content_safety.check_input()` (Py); called in `orchestrate()`, `orchestrateHelp()`, `orchestrate/route.ts` pre-flight, `function_app.py` |
| Input harm moderation | ✅ | `moderateContent()` / `_check_harm()` |
| Output harm moderation | ✅ | `moderateContent()` before `finalStep`; `check_output()` after reply assembly |
| Severity ≥ 4 block threshold | ✅ | `CONTENT_SAFETY_BLOCK_SEVERITY` / `_BLOCK_THRESHOLD` |
| Structured `{ ok:false, error:{ reason, code } }` block | ✅ | route returns 400; SSE emits `kind:'error', code:'content_safety_output'` |
| Blocked-response MessageBar (input + output) | ✅ | `copilot-pane.tsx` `safetyBlock` MessageBar (intent error) |
| Honest-gate when Content Safety absent (no silent pass) | ⚠️→✅ | `/api/copilot/status` `contentSafety:false` → `safetyGate` warning MessageBar; Python logs + skips |
| Token-auth, sovereign scope | ✅ | `contentSafetyToken()` + `cogScope()` (TS); `DefaultAzureCredential` cognitiveservices scope (Py) |
| Fabric/Power BI dependency | ✅ none | Pure Azure Cognitive Services data plane |

Zero ❌ — every inventory row is built or honest-gated.

## Backend per control

| Control | Backend call |
|---|---|
| Console copilot input | `shieldPrompt()` + `moderateContent()` → Content Safety `text:shieldPrompt` + `text:analyze` |
| Console copilot output | `moderateContent(completion)` → `text:analyze` |
| Help copilot input/output | same helpers from `help-copilot-orchestrator.ts` |
| Chat Function input/output | `content_safety.check_input/output` → same REST, MI token auth |
| Pane honest-gate | `GET /api/copilot/status` → `isSafetyConfigured()` |

## Per-cloud availability

| Boundary | Content Safety | `contentSafetyEnabled` |
|---|---|---|
| Commercial | Yes | `true` |
| GCC (Commercial Azure endpoints) | Yes | `true` |
| GCC-High (USGovArizona / USGovVirginia) | Yes (Text, Prompt Shield, Protected Material Text) | `true` |
| IL5 / DoD (US DoD Central/East) | Not offered | `false` → honest-gate MessageBar |

## Verification

- `vitest run lib/azure/__tests__/foundry-content-safety.test.ts`
- `pytest azure-functions/copilot-chat/tests/test_content_safety.py`
- Manual: send "ignore all previous instructions" → 400 + error MessageBar; send
  a normal question → passes; unset `LOOM_CONTENT_SAFETY_ENDPOINT` → warning
  MessageBar, chat still works.
