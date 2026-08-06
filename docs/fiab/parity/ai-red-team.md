# ai-red-team — parity with the Azure AI Foundry AI Red Teaming Agent

**Source UI:** Azure AI Foundry — AI Red Teaming Agent
<https://learn.microsoft.com/azure/foundry/concepts/ai-red-teaming-agent>
Supporting: <https://learn.microsoft.com/azure/foundry/how-to/develop/run-scans-ai-red-teaming-agent>
· <https://learn.microsoft.com/azure/foundry/how-to/develop/run-ai-red-teaming-cloud>
· <https://learn.microsoft.com/azure/foundry/how-to/evaluate-results>

**Surface file:** `apps/fiab-console/lib/editors/ai-red-team-editor.tsx` (276 lines)
**Model/probe corpus:** `apps/fiab-console/lib/foundry/red-team.ts` (213 lines)
**Route:** `/items/ai-red-team/[id]` · Tagged **Preview** in the catalog.

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

**Not A-grade.** The chrome is good and the backend is genuinely real — this is
a working safety scanner, not a stub. Two findings are worth escalating beyond
"add the missing rows":

1. **2.9 (no attack strategies) makes the headline number optimistic.** The
   surface reports an "attack success rate" computed **entirely from
   plaintext probes**. Microsoft's own framing is that converters are what
   defeat filters. A deployment scoring 0% here has not been shown to be safe —
   it has been shown to refuse the easy form. Until strategies land, the
   surface should say so on screen; right now it presents the number without
   that caveat.
2. **1.7 + 2.13 (no compare, no schedule)** mean the surface can measure once
   but cannot show that a fix worked, which is the actual red-teaming workflow.

Cheapest high-value fixes, in order: **2.16** (render the `byCategory` rollup
that is already computed), **1.4** (render the rationale that is already
fetched), **1.5** (export the scorecard), then **2.9** (strategies) as the real
capability investment.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); GitHub Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/ai-red-team/<id>
  ```
  The walk must run a real scan against a live deployment and confirm the
  refusal/ASR numbers move with the category selection.
- Coverage read from source; static evidence, not a functional grade
  (`no_scaffold_claims`).
