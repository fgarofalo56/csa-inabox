# copilot-governance — parity with an in-blade governance AI assistant

**Surface:** the Governance Copilot bar inside the **Govern** posture tile.
Component: `apps/fiab-console/lib/panes/govern-admin.tsx` → `PostureCopilotBar`
(mounted on `app/governance/govern/page.tsx`).
Route: `apps/fiab-console/app/api/governance/govern/copilot/route.ts`.

**Source UI (Microsoft):** the real-product analog is an **in-blade AI
assistant grounded in the live data on that blade** — the assistant answers
questions about exactly what you are looking at, citing the on-screen numbers.
- Copilot in Azure (in-context Q&A) — <https://learn.microsoft.com/azure/copilot/overview>
- Microsoft Purview Data Estate Insights (governance posture) — <https://learn.microsoft.com/purview/data-estate-insights-about>

> An in-blade governance assistant lets you (a) ask a question about the current
> posture, (b) get an answer grounded **only** in the live posture data (no
> hallucinated metrics), (c) read it as it streams, and (d) be told plainly when
> the data does not contain the answer. Loom reproduces all four **on the
> Azure-native default backend** — Azure OpenAI chat-completions grounded on the
> live Govern posture JSON — **with no Fabric / Power BI dependency**; works with
> `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. It is admin-gated (F2 tenant admin) and
> shows an honest gate when AOAI is not wired.

## Source-UI feature inventory (grounded in Learn)

| # | In-blade assistant capability | Behavior in the real UI |
| --- | --- | --- |
| 1 | Ask about the current posture | A question box scoped to the blade's data |
| 2 | Grounded answer (no invented metrics) | The answer cites the on-screen numbers; says so when data is absent |
| 3 | Streamed answer | The answer renders progressively |
| 4 | Admin-only access | The assistant is gated to governance admins |
| 5 | Graceful unconfigured state | A clear message when the model is unavailable |

## Loom coverage

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | Ask about posture | built ✅ | `PostureCopilotBar` Textarea + "Ask Copilot" → `POST /api/governance/govern/copilot {question, chartData}` where `chartData` is the live posture JSON |
| 2 | Grounded, no-invention answer | built ✅ | system prompt injects the compacted posture JSON (12k-char cap) and instructs "use ONLY this data … say so plainly … do NOT speculate" |
| 3 | Streamed answer (SSE) | built ✅ | route pipes AOAI `stream:true` chat-completions straight through; the bar parses `choices[0].delta.content` chunks into `answer` |
| 4 | Admin-only (F2) | built ✅ | `isTenantAdmin(session)` → non-admin gets `403 {code:'admin_only'}` |
| 5 | Honest no-AOAI gate | honest-gate ⚠️ | `NoAoaiDeploymentError` → `503 {code:'no_aoai', hint}` → `NotConfiguredBar surface="Governance Copilot"` naming `LOOM_AOAI_ENDPOINT` + the bicep module + the tenant-settings follow-up |

Zero ❌.

## Backend per control

| Control | Calls |
| --- | --- |
| Ask Copilot | `POST /api/governance/govern/copilot` `{question, chartData}` → `resolveAoaiTarget()` + `cogScope()` bearer → AOAI `chat/completions` `stream:true`, temp 0.2 (reasoning-model temp-retry) → SSE delta chunks |
| Grounding | the live Govern posture JSON (`posture` from the Govern tile) is serialized + truncated to ≤12k chars and injected as the system prompt |
| Admin gate | `isTenantAdmin()` from `lib/auth/feature-gate` |

## Azure-native / no-Fabric

No Fabric / Power BI host on any path. The backend is Azure OpenAI only; the
grounding data is the Loom-native governance posture (Purview-classic + Loom
catalog signals), not a Fabric/Power BI dataset.

## Bicep sync

- Reuses `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_AUDIENCE`
  from `admin-plane/main.bicep` (lines 1583–1594). No new infra.
- **Cognitive Services OpenAI User** role to the Console UAMI already ships in
  `foundry-project.bicep`.

## Per-cloud notes

| Concern | Commercial / GCC | GCC-High / IL5 / DoD |
| --- | --- | --- |
| AOAI scope | `cogScope()` → `cognitiveservices.azure.com/.default` | `cognitiveservices.azure.us/.default` |
| AOAI endpoint | `*.openai.azure.com` (`LOOM_AOAI_ENDPOINT`) | `*.openai.azure.us` |
| Fabric / Power BI host | never contacted | never contacted |

## Verification

`pnpm uat` — `e2e/copilot.uat.ts` "Governance Copilot" block: navigate
`/governance/govern`, type a question in the posture Copilot bar, **Ask
Copilot** → assert one of: a streamed answer renders, a `503 no_aoai` honest
gate, or a `403 admin_only` (all valid; a generic 500 is not). Receipt
screenshot under `test-results/uat/artifacts/`.

Grade: **A** (every inventory row built ✅ or honest-gate ⚠️; real streamed AOAI
backend grounded in live posture; admin-gated; UAT-covered).
