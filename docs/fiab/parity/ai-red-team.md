<!-- parity-doc-meta
Reviewed-on: 2026-08-23
Validated-against:
  - apps/fiab-console/lib/editors/ai-red-team-editor.tsx
  - apps/fiab-console/lib/foundry/red-team.ts
  - apps/fiab-console/app/api/items/ai-red-team
-->

# ai-red-team — parity with the Azure AI Foundry AI Red Teaming Agent

**Source UI:** Azure AI Foundry — AI Red Teaming Agent
<https://learn.microsoft.com/azure/foundry/concepts/ai-red-teaming-agent>
Supporting: <https://learn.microsoft.com/azure/foundry/how-to/develop/run-scans-ai-red-teaming-agent>
· <https://learn.microsoft.com/azure/foundry/how-to/develop/run-ai-red-teaming-cloud>
· <https://learn.microsoft.com/azure/foundry/how-to/evaluate-results>

**Surface file:** `apps/fiab-console/lib/editors/ai-red-team-editor.tsx` (430 lines)
**Model/probe corpus:** `apps/fiab-console/lib/foundry/red-team.ts` (394 lines)
**Route:** `/items/ai-red-team/[id]` · Tagged **Preview** in the catalog.

> **rev.2 (2026-08-23).** rev.1 was written 2026-08-07 (#3071) and cited 276 /
> 213 lines. Both files grew the next day — #3130 (2026-08-08) added the coverage
> caveat — so every line reference below rev.1 was off by roughly 40%, and the
> Verdict's headline finding had already been fixed before the doc's own tracking
> issue (#3722) was filed on 2026-08-18. Line counts and Verdict §1 corrected
> here; the ❌ rows were re-checked against the deployed SHA and stand.

## Scoping note that materially changes this comparison

Microsoft's red-teaming agent is **SDK/API-first**. Learn documents **no portal
authoring wizard** — configuration is `azure-ai-evaluation[redteam]` locally, or
`azure-ai-projects` + `client.evals.create` in the cloud. The only *rendered*
Foundry portal surface is the shared **Evaluation** page where runs land, plus
the JSON scorecard artifact.

So the inventory below is split into two blocks, because grading them the same
way would be dishonest:

- **Block 1 — portal-rendered.** Loom must match these to claim UI parity.
- **Block 2 — SDK/API configuration.** Microsoft exposes these only in code.
  Loom building them as UI is *ahead* of the portal; not building them is a gap
  in **capability**, not in *UI* parity. Both readings matter, so both are
  graded, and the totals are reported separately.

## Block 1 — Foundry portal-rendered surface

| # | Foundry capability | Loom coverage | Backend / evidence |
|---|---|---|---|
| 1.1 | Evaluation runs list (Name, Target, Dataset, Status, tokens, Scores) | ✅ | **Runs** tab renders a real history table (Started / Deployment / Probes / Refusal / Attack success) from persisted item state. `:242-271` |
| 1.2 | Run status lifecycle (queued/running/succeeded/failed) | ⚠️ | Only a binary `running` flag + `ProgressBar`. No queued state, no per-probe progress, no cancel. A long scan shows an indeterminate bar with no way to stop it. |
| 1.3 | Row-level drill-in: query, response, score, explanation | ✅ | Results table gives Category / Probe / Verdict / Safety / Response with full text in `title=` tooltips. Rationale is captured in the model (`RedTeamResultLite.rationale`) — **but never rendered**, see 1.4. |
| 1.4 | Score explanation shown to the user | ❌ | The judge's `rationale` and the Content Safety `severity_label` reason are fetched and stored but **no cell displays the rationale**. The user sees a verdict with no "why". |
| 1.5 | Dataset CSV download per run | ❌ | No export of any kind — no CSV, no JSON scorecard download. |
| 1.6 | Score-cell hover tooltip → token usage + "Learn more about metrics" | ❌ | No token accounting is captured or shown; no metric-definition link from the score cells. (A `TeachingBanner` "Learn more" links to the concepts page — that is 1.9, not this.) |
| 1.7 | Run comparison view (select 2+ → Compare, baseline + t-test) | ❌ | Not built. Runs can only be read one at a time. This is the highest-value missing portal feature: red teaming is inherently a before/after activity (harden a filter, re-scan, prove the ASR moved) and Loom cannot show that. |
| 1.8 | Named scan run (`scan_name`) | ❌ | Runs are identified by timestamp + deployment only; no user-supplied name field. |
| 1.9 | In-product guidance | ✅ | `TeachingBanner surfaceKey="ai-red-team-editor"` with `learnMoreHref` to the Learn concepts page. |
| 1.10 | Region availability disclosure | ❌ | Cloud red teaming is limited to East US 2 / France Central / Sweden Central / Switzerland West / US North Central. Loom's own scan is AOAI-judge-based so the limit may not apply — but the surface says nothing either way, so a user cannot tell. |
| 1.11 | Harmful-input redaction in stored results | ⚠️ | Responses are truncated to 600 chars before persisting (`:118`) — a size guard, not a redaction policy. Microsoft **redacts** harmful inputs from results. Loom persists probe + response text verbatim into Cosmos. Worth a deliberate decision by the security lane rather than an accident. |

**Block 1: 3 ✅ · 2 ⚠️ · 6 ❌ (11 rows).**

## Block 2 — Foundry SDK/API configuration surface

| # | Foundry capability | Loom coverage | Notes |
|---|---|---|---|
| 2.1 | Scan target: AOAI/Foundry model deployment | ✅ | Real `GET /api/foundry/model-deployments` dropdown, account-scoped. Honest gate when none listed. |
| 2.2 | Scan target: callback / PyRIT `PromptChatTarget` / hosted agent | ❌ | Deployment only. A Loom `agent-flow` or `data-agent` cannot be red-teamed. |
| 2.3 | Risk-category multi-select | ✅ **exceeds** | Loom ships **10** categories (violence, self-harm, hate, sexual, illicit-drugs, weapons, malware, privacy, jailbreak, prompt-injection) vs Microsoft's 7. Jailbreak (UPIA) and prompt-injection (XPIA) are modelled as *categories* here where Microsoft models them as *strategies* — different shape, comparable coverage. |
| 2.4 | Agentic risk categories (prohibited actions, sensitive-data leakage, task adherence) | ❌ | Not modelled. Requires a tool-calling target (see 2.2). |
| 2.5 | `num_objectives` — probes per category | ❌ | Fixed corpus. `MAX_RED_TEAM_PROMPTS = 40` is a module constant with no UI control. |
| 2.6 | Custom attack-objective dataset upload | ❌ | The probe corpus is compiled into `red-team.ts`; no upload, no per-tenant probe set. |
| 2.7 | Language selector (es/it/fr/ja/pt/zh-Hans) | ❌ | English only. |
| 2.8 | Attack-strategy complexity groups (EASY / MODERATE / DIFFICULT) | ❌ | No strategy concept at all. |
| 2.9 | 24 individual PyRIT converters (Base64, ROT13, Leetspeak, Morse, Caesar, Flip, CharSwap, Tense, …) | ❌ | **The single largest capability gap.** Loom sends each probe verbatim. Microsoft's core insight is that the *same* objective encoded through a converter defeats filters that block the plaintext — an ASR measured without converters systematically **overstates** a deployment's safety. |
| 2.10 | Strategy composition (`Compose([a,b])`) | ❌ | Consequence of 2.9. |
| 2.11 | Multi-turn / Crescendo (`num_turns`) | ❌ | Every probe is single-turn. Crescendo-class escalation is unmeasurable. |
| 2.12 | Prohibited-actions taxonomy generate/review/edit | ❌ | Not modelled. |
| 2.13 | Scheduled continuous red teaming | ❌ | Manual runs only. No schedule, no drift detection against a baseline. |
| 2.14 | ASR scorecard: overall + per-risk-category summary | ✅ | `summary.refusalRate`, `summary.attackSuccessRate`, and `summary.byCategory` are all computed. |
| 2.15 | ASR scorecard: per-attack-technique summary + `detailed_joint_risk_attack_asr` | ❌ | Consequence of 2.9 — with no strategies there is no per-technique breakdown. |
| 2.16 | `byCategory` breakdown rendered in the UI | ❌ | It is **computed and persisted but never displayed**. The results table is flat per-probe; there is no per-category rollup on screen even though the data is right there. Cheapest real win on this surface. |
| 2.17 | Parameters/provenance block (which categories, which complexities, techniques used) | ⚠️ | Deployment + categories are persisted per run; no technique list (2.9) and no probe-corpus version, so a historical run cannot be reproduced if the compiled corpus changes. |
| 2.18 | Content Safety severity scoring | ✅ **exceeds portal** | Optional `Switch` wires Azure AI Content Safety scoring per response, surfaced as `safetyCategory severity` per row. |
| 2.19 | Verdict classification (refused / partial / unsafe) | ✅ | AOAI judge with a heuristic fallback — a real classification path, not a keyword match. |

**Block 2: 5 ✅ (2 of them exceeding Microsoft) · 1 ⚠️ · 13 ❌ (19 rows).**

**Combined totals: 8 ✅ · 3 ⚠️ · 19 ❌ (30 rows).**

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Account field (blur) / deployment dropdown | `GET /api/foundry/model-deployments?account=` | Azure AI Foundry / Azure OpenAI control plane |
| **Run red-team scan** | `POST /api/items/ai-red-team/:id/run` | Live inference against the selected AOAI **model deployment**, per-response **AOAI judge**, optional **Azure AI Content Safety** `analyzeText` |
| Save | `PATCH` via `useItemState('ai-red-team', id)` | Cosmos DB |
| Category checkboxes, Content-Safety switch | client state → persisted on Save | — |

Every control hits a real backend. No mock arrays. No Fabric/Power BI host is
contacted on any path — `no-fabric-dependency.md` satisfied.

## ux-baseline §7 spot-check (this surface is well-built)

| Bar | Status |
|---|---|
| `ItemEditorChrome` + ribbon + command registration | ✅ |
| `TeachingBanner` + Learn link | ✅ |
| Tabs (Scan / Runs) with counts | ✅ |
| `NewItemCreateGate` — clean first-open, no red on a fresh item | ✅ |
| Fluent v9 + Loom tokens throughout, `flexWrap` on every badge row | ✅ |
| Honest gate when no deployments | ⚠️ — a `MessageBar intent="warning"` carrying the route's `hint`, but **not** the shared `HonestGate`, so no inline **Fix it** and no gate-registry entry (**G2**). |
| Results grid uses `PreviewTable` (type badges + timing bar) | ❌ — hand-built `<Table>`; no timing bar, no type badges. |
| G3 resizable panes (`SplitPane` + `sizingKey`) | ❌ — `maxHeight: '48vh'` is fixed. |

## Verdict

**Grade: B−.** (rev.1 recorded only "Not A-grade", which is a status, not a
grade — the omission #3722 was filed against. Scored here on the
`no-vaporware.md` rubric, capped by `ui-parity.md`.)

Why B− and not higher: every control hits a real backend, the chrome is complete,
and `lib/editors/__tests__/ai-red-team.test.tsx` covers it — that is B territory.
It cannot be A: `ui-parity.md` grants A only at **zero ❌**, and this surface
carries **19 of 30 rows ❌**. It cannot be B either, because two platform
standards are unmet (**G2** — the no-deployments gate is a bare `MessageBar`, not
the shared `HonestGate`, so no inline Fix-it and no gate-registry entry; **G3** —
`maxHeight: '48vh'` instead of `SplitPane` + `sizingKey`) and the **V3
in-browser walk is still owed**.

Why B− and not lower: this is a working safety scanner against live inference
with a real AOAI judge and optional Content Safety scoring. Nothing here is a
stub, and the ❌ rows are missing *breadth*, not fake depth.

The finding worth escalating past "add the missing rows":

1. **2.9 (no attack strategies) still makes the headline number optimistic.**
   The surface reports an attack success rate computed **entirely from plaintext
   probes**. Microsoft's framing is that converters are what defeat filters, so a
   deployment scoring 0% here has not been shown to be safe — it has been shown
   to refuse the easy form. This remains a genuine capability gap.
   **What is no longer true:** rev.1 added "right now it presents the number
   without that caveat". That was fixed by **#3130 (2026-08-08)**, the day after
   this doc was written. At the deployed SHA `2fe9d68b` the editor carries
   `scoreIsMeaningful` in five places — a `MessageBar` that flips from
   `intent="info"` to `intent="warning"` and retitles itself *"This score does
   NOT establish that the deployment is safe"*, plus a targeted caption under a
   0% result reading *"0% across a baseline-only run — not a safety result."*
   The number is now disclosed. The gap is the missing measurement, not a
   missing warning.
2. **1.7 + 2.13 (no compare, no schedule)** mean the surface can measure once but
   cannot show that a fix worked, which is the actual red-teaming workflow.

### The 19 ❌ rows, grouped and sized

#3722 asks for these to be tracked rather than left as a wall. They are not 19
independent work items — two of them are explicitly downstream of a third (2.10
and 2.15 both read *"Consequence of 2.9"* in the table above), so Group A
collapses on a single build.

| Group | Rows | Size | Note |
|---|---|:--:|---|
| **A — Attack strategies (PyRIT converters)** | 2.8, 2.9, 2.10, 2.11, 2.15, and the per-technique half of 2.17 | L | The real capability investment. 2.10/2.15 and part of 2.17 fall out for free once 2.9 lands; `byTechnique` is **already in the summary type** (`ai-red-team-editor.tsx:52`), so the rollup has a slot waiting. |
| **B — Render what is already computed** | 2.16, 1.4 | S | Cheapest real wins on the surface. `byCategory` is computed and persisted; at the deployed SHA it appears in the editor exactly **once**, as a type declaration (`:51`) — never in a rendered element. The judge `rationale` is likewise fetched and stored but never shown. |
| **C — Run identity and export** | 1.5, 1.8 | S | A `scan_name` field and a CSV/JSON scorecard export. |
| **D — Run lifecycle and comparison** | 1.2 (⚠️), 1.7, 2.13 | M | Queued/cancel states, run-vs-run compare with a baseline, scheduled re-scan. Group D is what turns the surface from a measurement into a control. |
| **E — Target breadth** | 2.2, 2.4, 2.12 | M | Callback / PyRIT target / hosted agent. 2.4 explicitly depends on it (*"Requires a tool-calling target (see 2.2)"*); 2.12 is adjacent rather than strictly blocked. |
| **F — Corpus control** | 2.5, 2.6, 2.7 | M | `num_objectives`, custom objective upload, non-English probes. |
| **G — Disclosure** | 1.6, 1.10 | S | Token accounting on the score cells; a region-availability statement. |

Recommended order: **B** (hours, already-computed data) → **C** → **D** → **A**
(the one that changes what the number means) → **E** / **F** / **G**.

All seven groups are **code changes in the console editor and `red-team.ts`** —
out of scope for a docs pass. They belong to the console lane.

## Verification

- **V3 (in-browser click-walk): OWED — but no longer blocked.** rev.1 recorded
  `loom-ui-verify` as "red since 2026-08-04 (FINISHLINE C13); GitHub Actions
  degraded". That is no longer true: the workflow produced a **success on
  2026-08-15T23:59:20Z** against `main` (its most recent run, 2026-08-17, failed
  again — so it is flaky, not down). The walk is runnable today; it simply has
  not been run for this surface. Distinguishing the two matters, because "the
  workflow is down" reads as *not our move* and it is now our move:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/ai-red-team/<id>
  ```
  The walk must run a real scan against a live deployment and confirm the
  refusal/ASR numbers move with the category selection — and, since #3130, that
  the coverage `MessageBar` flips to `intent="warning"` on a baseline-only run.
- Everything above this line is **read from source at the deployed SHA
  `2fe9d68b`** (Commercial `/build-marker.txt` stamp `20260823T104511Z`; Gov on
  the same SHA). That is static evidence, not a functional grade
  (`no_scaffold_claims`) — the grade is capped at B− partly *because* of it.
