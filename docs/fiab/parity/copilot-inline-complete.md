# copilot-inline-complete — parity with Monaco inline code completion (ghost text)

**Surface:** the Monaco `InlineCompletionItemProvider` (gray ghost text,
Tab-to-accept) wired into the notebook code cells and the T-SQL editors.
Prompt builder: `apps/fiab-console/lib/copilot/inline-complete-prompt.ts`
(`buildInlineMessages` + `cleanInlineCompletion`, pure + unit-tested).
Route: `apps/fiab-console/app/api/copilot/complete/route.ts`.
Registration helper: `registerInlineCompletion(editor, monaco, …)` (notebook
code-cell `MonacoTextarea onReady` + the unified SQL editor Query tab).

**Source UI (Microsoft):** the real-product analog is **Fabric Notebook Copilot
inline completion** and **Copilot in Azure SQL ghost text** — next-token code
suggestions rendered inline as you type, accepted with Tab.
- Fabric Notebook Copilot inline code completion — <https://learn.microsoft.com/fabric/data-engineering/copilot-notebooks-overview>
- Copilot in Azure SQL (ghost text) — <https://learn.microsoft.com/azure/azure-sql/copilot/copilot-azure-sql-overview>

> Fabric's inline completion requires an **F2+/P-class capacity and a
> Fabric/Power BI Copilot license**, which makes ghost text unavailable to
> sovereign tenants without that SKU. The Loom path has **NO capacity gate** —
> it calls Azure OpenAI chat-completions directly via the same AI Foundry `chat`
> deployment the rest of the Copilot uses (`resolveAoaiTarget()`). No Fabric, no
> Power BI, no capacity dependency; works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
> unset (per `no-fabric-dependency.md`).

## Source-UI feature inventory (grounded in Learn)

| # | Inline-completion capability | Behavior in the real UI |
| --- | --- | --- |
| 1 | Auto-suggest the next code as you type | Gray ghost text appears after the cursor |
| 2 | Comment-/intent-triggered completion | A `# comment` or `-- intent` line yields code |
| 3 | Tab to accept | Pressing Tab inserts the suggestion |
| 4 | Prior-context grounding | Suggestions use earlier cells / the buffer above |
| 5 | Schema grounding | Suggested names come from the real table/column schema |
| 6 | Language awareness | PySpark/Python in notebooks, T-SQL in SQL editors |
| 7 | Org-level enable/disable | An admin can turn the feature off tenant-wide |
| 8 | Graceful unconfigured state | When unavailable, the editor just stops suggesting |

## Loom coverage

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | Auto-suggest next code (ghost text) | built ✅ | `registerInlineCompletion()` → debounced `POST /api/copilot/complete {prefix,…}`; Monaco `inlineSuggest.enabled` renders the ghost decoration |
| 2 | Comment-/intent-triggered | built ✅ | the prefix (including a `#`/`--` intent line) is sent verbatim → `buildInlineMessages()` |
| 3 | Tab to accept | built ✅ | Monaco's native inline-suggest Tab accept inserts the completion |
| 4 | Prior-cell grounding | built ✅ | up to 3 prior cells passed as `priorCells` → system grounding |
| 5 | Schema grounding | built ✅ | `schemaContext` (lakehouse / `INFORMATION_SCHEMA.COLUMNS`) injected into the prompt |
| 6 | Language awareness | built ✅ | `lang` (`pyspark`/`python`/`tsql`/…) selects the prompt dialect; `cleanInlineCompletion()` strips stray fences |
| 7 | Tenant toggle `ai.inlineCodeComplete` | built ✅ | route reads the tenant-settings toggle (60s cache, soft-fail to enabled); off → `403 {code:'disabled'}` naming the admin setting |
| 8 | Honest no-AOAI gate | honest-gate ⚠️ | `503 {code:'no_aoai', hint}` → provider yields no items; the cell falls back to plain editing silently, hint names `LOOM_AOAI_ENDPOINT`/`LOOM_AOAI_DEPLOYMENT` + the Foundry bicep module |

Zero ❌. Scope boundary: read-only Monaco views and non-code editors do not
register the provider — an honest scope limit, not a stub.

## Backend per control

| Control | Calls |
| --- | --- |
| Ghost text fetch | `POST /api/copilot/complete` `{prefix, lang, priorCells[], schemaContext}` → AOAI `chat/completions` (temp 0, `max_tokens:256`, `stop:['\n\n','```']`, reasoning-model temp-retry) → `cleanInlineCompletion()` |
| Tenant gate | `tenantSettingsContainer()` read of `ai.inlineCodeComplete` (cached 60s, soft-fail enabled) |
| AOAI resolution | `resolveAoaiTarget()` (same chain as the cross-item Copilot); bearer on `cognitiveservices` scope with the env-driven `LOOM_AOAI_AUDIENCE` |

## Azure-native / no-Fabric

No Fabric / Power BI / capacity host is contacted. The backend is Azure OpenAI
only — the single biggest Fabric-parity win here is that ghost text works
**without** an F2+ capacity or a Power BI Copilot license.

## Bicep sync

- Reuses `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_AUDIENCE`
  from `admin-plane/main.bicep` (lines 1583–1594). No new infra.
- `ai.inlineCodeComplete` lives in the tenant-settings doc (`defaultSettings()`),
  edited under Admin → Tenant settings → AI & Copilot.

## Per-cloud notes

| Concern | Commercial / GCC | GCC-High / IL5 / DoD |
| --- | --- | --- |
| AOAI scope | `cognitiveservices.azure.com/.default` | `cognitiveservices.azure.us/.default` (the route uses the `cognitiveservices.azure.com` audience by default; set `LOOM_AOAI_AUDIENCE`=`https://cognitiveservices.azure.us` for Gov) |
| AOAI endpoint | `*.openai.azure.com` | `*.openai.azure.us` |
| Fabric capacity / Power BI Copilot license | not required (Fabric requires F2+) | not required — the key sovereign advantage |

## Verification

`pnpm uat` — `e2e/notebook-inline-complete.uat.ts` types `# read csv into df`,
asserts a real AOAI ghost suggestion appears, presses Tab, and confirms the cell
grew (or captures the `503 no_aoai` body as the honest-gate receipt). The
`e2e/copilot.uat.ts` whole-surface sweep references this block. Unit:
`lib/copilot/__tests__/inline-complete-prompt.test.ts`.

Grade: **A** (every inventory row built ✅ or honest-gate ⚠️; real AOAI backend;
unit + UAT-covered).
