# foundry-evaluations — parity with AI Foundry Evaluations (Azure OpenAI Evals)

> Brutally-honest 1:1 parity audit (2026-06-01). Grading per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`. Graded
> conservatively; when in doubt, graded DOWN.
>
> Scope: the **Evaluations** tab of the AI Foundry hub editor — list evaluations,
> create an evaluation (data schema + grader), and view grading runs. The broader
> Foundry audit (playgrounds, agents, deployments, connections) lives in
> `ai-foundry.md`; this doc isolates the Evals surface.

**Source UI (grounded in Microsoft Learn, not memory):**
- Azure OpenAI Evals (data-plane preview) reference — list/create evals, list runs: https://learn.microsoft.com/azure/ai-foundry/openai/reference-preview-latest#list-evals
- Evals authoring reference (get run list, run results): https://learn.microsoft.com/azure/ai-foundry/openai/authoring-reference-preview
- AI Foundry evaluation concepts (graders / testing criteria, datasets, runs): https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai
- Cloud evaluation (run an evaluation on a dataset, results, metrics): https://learn.microsoft.com/azure/ai-foundry/how-to/develop/cloud-evaluation

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/foundry-hub-editor.tsx` — `EvaluationsPanel`
  (evals table → select → runs table) + `CreateEvalDialog` (name + grader).
- BFF: `apps/fiab-console/app/api/foundry/evaluations/route.ts`.
- Client (real REST, no mocks): `apps/fiab-console/lib/azure/foundry-cs-client.ts`
  — `listEvals`, `createEval`, `listEvalRuns`.

**Backend reality check.** All three actions call the real Azure OpenAI Evals
data-plane: `GET {endpoint}/openai/v1/evals`, `POST {endpoint}/openai/v1/evals`,
`GET {endpoint}/openai/v1/evals/{id}/runs`, against the account chosen by the
Foundry account picker. Create posts a **valid testing-criteria schema** (string_check
or label_model grader + a custom data-source schema). No `return []`, no `MOCK_`, no
`useState(SAMPLE)`. Honest gates: 503 `notDeployed` (account not Foundry-enabled) and
a precise 404 hint ("Evals is a preview feature; enable it on the account/region").

---

## Azure feature inventory → Loom coverage → backend

Legend: built ✅ · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Evaluation list & account scope

| # | Foundry Evaluation capability | Loom | Where / backend |
|---|---|---|---|
| A1 | List evaluations for the selected account | ✅ built | `EvaluationsPanel` → `GET /api/foundry/evaluations` |
| A2 | Show eval name · id · created date | ✅ built | evals table |
| A3 | Account picker scopes the list (name + region badge) | ✅ built | `acct` selector; account badge |
| A4 | Reload | ✅ built | Reload button |
| A5 | Honest gate when account isn't Foundry / Evals-preview | ✅ built | `GateBar` (notDeployed) + 404 preview hint |
| A6 | Delete an evaluation | ❌ MISSING | no delete |
| A7 | Open eval detail (data schema / criteria view) | ❌ MISSING | runs-only drill |

### B. Create evaluation

| # | Foundry Evaluation capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Create eval (name) | ✅ built | `CreateEvalDialog` → `POST /api/foundry/evaluations` `createEval` |
| B2 | Grader: **String check** (exact/reference match, reference template) | ✅ built | string_check criteria + reference field |
| B3 | Grader: **Label model** (LLM-graded pass/fail) | ✅ built | label_model criteria (gpt-4o-mini grader) |
| B4 | Data-source schema (custom item schema: input/expected) | ✅ built | `dataSourceConfig` posted with the eval |
| B5 | Other graders: **text similarity, BLEU/ROUGE/METEOR, F1, groundedness, relevance, coherence, fluency, similarity, custom code** | ❌ MISSING | 2 grader types only |
| B6 | Multiple testing criteria per eval | ⚠️ partial | BFF accepts an array; dialog authors exactly one |
| B7 | Map graders to **AI-assisted / risk-&-safety** evaluators (content harm, jailbreak) | ❌ MISSING | not surfaced |
| B8 | Custom data-source schema editor (arbitrary item fields) | ⚠️ partial | fixed input/expected schema; not editable in the dialog |

### C. Runs

| # | Foundry Evaluation capability | Loom | Where / backend |
|---|---|---|---|
| C1 | List runs for an evaluation | ✅ built | "View runs" → `GET …?evalId=` `listEvalRuns` |
| C2 | Run row: name · status · model · passed/failed/total · report link | ✅ built | runs table; status color badge |
| C3 | Open the run **report** (deep link) | ✅ built | `reportUrl` "Open" link |
| C4 | **Start a run** (attach a JSONL dataset + model) | ❌ MISSING | honest copy: "start a run via the Evals REST API or the Foundry Evaluation surface" |
| C5 | **Upload a JSONL dataset** for a run | ❌ MISSING | not surfaced |
| C6 | Per-row results table (input/output/grade/passed) | ❌ MISSING | aggregate counts only |
| C7 | Cancel / delete a run | ❌ MISSING | not surfaced |
| C8 | Metric charts / pass-rate trend across runs | ❌ MISSING | counts only, no charts |
| C9 | Compare runs side-by-side | ❌ MISSING | not surfaced |

---

## Coverage tally

- **built ✅: 13**
- **partial ⚠️: 2**
- **honest-gate ⚠️: 1** (the Evals-preview / notDeployed account gate)
- **MISSING ❌: 11**

## Honest grade: **C+**

The Evaluations panel is **functional and honest**: it lists real evals, creates a
real eval with a valid Evals testing-criteria schema (two grader types), and shows
real grading runs with pass/fail/total counts and a report deep-link — all against
the live Azure OpenAI Evals data-plane, scoped by the account picker, with precise
gates for the not-deployed and preview-not-enabled cases. **No vaporware** — the
"start a run via the REST API" copy is an honest disclosure of a genuinely-missing
path, not a dead button.

Held to **C+** by `ui-parity.md`'s completeness bar: the **defining operator
action — starting a run against a JSONL dataset — is missing** (you can define an
eval but not execute one from Loom), there's **no dataset upload**, **no per-row
results table** (only aggregate counts), **no metric charts / run comparison**, and
only **2 of the many grader/evaluator types** (no text-similarity, BLEU/ROUGE,
groundedness/relevance/coherence/fluency, or risk-&-safety evaluators). It's a
credible read + create-structure surface short of the full evaluate-and-analyze loop.

## Highest-value gaps to build first

1. **Start a run** (C4) + **JSONL dataset upload** (C5) — turns this from
   define-only into a working evaluate loop. Highest value.
2. **Per-row results table** (C6) — the actual grading output.
3. **More graders / AI-assisted + risk-&-safety evaluators** (B5/B7).
4. **Editable data-source schema + multiple criteria in the dialog** (B6/B8).
5. **Metric charts / run comparison** (C8–C9) and **eval/run delete** (A6/C7).

## Backend per control

| Control | BFF route | client fn | Evals endpoint |
|---|---|---|---|
| List evals | `GET /api/foundry/evaluations` | `listEvals` | `GET {endpoint}/openai/v1/evals` |
| Create eval | `POST /api/foundry/evaluations` | `createEval` | `POST {endpoint}/openai/v1/evals` |
| List runs | `GET …?evalId=` | `listEvalRuns` | `GET {endpoint}/openai/v1/evals/{id}/runs` |

## Bicep / env sync

- Scope: the AI Foundry / Azure OpenAI account is selected at runtime via the account
  picker (`?account=&rg=`), per `ai-foundry.md`.
- Role: Loom UAMI needs data-plane access to the account (Cognitive Services
  OpenAI Contributor/User); Evals must be **preview-enabled** on the account/region
  (the 404 hint says so verbatim).
- No new Cosmos container.

## Verification

- Per `no-vaporware.md`: list/create/runs hit the real Evals data-plane; gates are
  honest (notDeployed 503 + preview 404 hint).
- Live `pnpm uat` side-by-side against the Foundry Evaluation surface: **pending**
  (requires an Evals-preview-enabled account + minted session). MISSING/partial rows
  derived from code; confirm against the live portal per the no-scaffold rule.
