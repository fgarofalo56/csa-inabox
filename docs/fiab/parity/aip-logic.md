# aip-logic — parity with Palantir AIP Logic (typed AI logic + tool-calling agents)

Loom slug: `aip-logic` · restType `AipLogic` · category **Fabric IQ** · brand **Spindle (Spindle Studio)** · editor `apps/fiab-console/lib/editors/palantir/aip-logic-editor.tsx` → `AipLogicEditor`.

**Source UI:** Palantir AIP Logic — <https://www.palantir.com/docs/foundry/logic/getting-started>
(3-pane no-code studio: Inputs/Blocks/Outputs · Debugger · Run panel.)

**Cloud rule:** Azure-native is the DEFAULT and is fully functional with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. LLM runtime = **Azure OpenAI** (`data-agent-client` / `copilot-orchestrator`, tier-routed via `model-tier-router`); ontology data = **Synapse / ADX / ADLS** via the bound Weave ontology; persistence = **Cosmos**; publish-as-REST = **APIM (`importApiFromOpenApi`) → the console `/invoke` route (OSDK/DAB-style)**; evals judge = **Azure OpenAI** (`aoai-chat-client`); Foundry-agent publish is an opt-in target (Gov-gated honest 501). No Microsoft Fabric / Power BI dependency anywhere on the default path.

> **State note (2026-07-20, WS-4.6):** this doc was previously STALE — it described
> a flat, 3-type, no-debugger editor as "current" and everything else as a build
> plan. The code had already surpassed that (the full typed block-graph engine,
> debugger, run history, and Foundry-agent publish shipped earlier), and WS-4.6
> added the **3-pane Studio shell, model/settings panel, evals-in-CI publish gate,
> publish-as-REST + Uses/curl, and version diff**. The coverage table below is the
> true current state.

---

## Real feature inventory (Palantir AIP Logic)

Grounded in the AIP Logic "Getting started" docs. Every capability the real product exposes:

### A. Studio shell / layout
1. **Three-pane layout** — left: Inputs / Blocks / Outputs configuration boards; center: **Debugger**; right: **Run panel** (run, run history, unit tests, automations).
2. File-creation flow (Files → +New → AIP Logic); Logic must live in a project folder.
3. Top nav + quick search (CMD/CTRL+J); contextual right sidebar.
4. **Uses** tab — curl snippet to invoke the Logic externally (hidden when output is ontology edits).
5. **Version history** tab.

### B. Typed inputs (Inputs board)
6. Per-input **name + type**; supported types: `array, boolean, date, double, float, integer, long, media reference, model, object, object list, object set, short, string, struct, timestamp`.
7. Object / object-set / object-list inputs are typed to an **ontology object type**.
8. `model` input = an LLM/model reference; `media reference` = blob/media handle.

### C. Blocks (ordered logic graph)
9. **Create variable** block (typed local var, primitive or object).
10. **Get object property** block (read a property off an ontology object).
11. **Use LLM** block — prompt + model; can call **tools**.
12. **Apply action** block / **Apply actions tool** (propose ontology edits inside Use LLM).
13. **Execute function** block (call another Logic function or a function-on-object via the **Ontology function tool**).
14. **Transform** block (compute/derive).
15. **Conditional / branch** + iteration over collections ("many block types").
16. **Block outputs** — every block emits a named, typed intermediary output that later blocks reference (variable wiring).
17. Use-LLM **tool configuration**: Apply-actions tool, Ontology-function tool, function tools; prompt fields per tool binding.

### D. Outputs board
18. **Logic function output** — either a **Value** (typed) or **all the Ontology edits** the function made.
19. Intermediary block outputs can be flagged for capture/eval (flask icon).

### E. Debugger (center pane)
20. LLM **chain-of-thought (CoT)** display.
21. **Block cards** — expand/collapse per block; show inputs, generated prompt, output, timing.
22. **Tool-call logs** (clear/inspect tool calls).
23. **Proposed ontology edits** shown in-scenario (not applied unless run via a published Action/automation).
24. Final output visualization.

### F. Run panel (right pane)
25. **Run** the Logic; **Generate sample output**.
26. **Run history** — list recent runs, select to view output + debug log.
27. **Unit tests** — save a version of inputs as a test; re-run for evaluation.
28. **AIP Evals** association — block-level / suite evaluation of intermediate + final outputs.
29. **Automations** — start/create automations from the Logic dashboard.

### G. Versioning / publish / operationalize
30. **Save** then **Publish** (Publish sits next to Save).
31. **Version comparison view** — diff two versions: blocks edited / added / removed.
32. **Wrap published Logic as an Action** (backs an ontology Action).
33. Use published Logic operationally — in Workshop, in Automations, called from other Logic / functions-on-objects.
34. **Uses** tab curl for external REST invocation.

### H. Settings / admin
35. **Execution mode** settings.
36. **Model / LLM capacity** selection; enable-AIP gates.
37. **Compute / metrics** (compute usage, run metrics).

---

## Loom coverage (current state — WS-4.6)

Legend: ✅ built · ⚠️ honest-gate / cross-surface · ❌ MISSING

| # | Real capability | Loom today | Backend |
|---|---|---|---|
| 1 | 3-pane studio layout | ✅ 3-pane `SplitPane` (authoring · Debugger · Run+settings), each resizable + persisted (`aip-logic.studio.*`) | — |
| 2 | File-creation flow | ✅ Catalog +New → `NewItemCreateGate` (item lives in a workspace) | Cosmos |
| 3 | Top nav + quick search | ✅ `ItemEditorChrome` command search + ribbon command palette | — |
| 4 | Uses / curl tab | ✅ Publish tab → **Uses** card: callable APIM URL + copy-able `curl` | APIM gateway |
| 5 | Version history tab | ✅ Versions tab (Cosmos `state.versions`) | Cosmos |
| 6 | Typed input types | ✅ full 16-type set (`AIP_INPUT_TYPES`) | `state.inputs` |
| 7 | object / object-set / object-list inputs | ✅ typed to the bound ontology's entity types | ontology surface |
| 8 | model / media-reference inputs | ✅ typed (keyed by id/handle); resolved at invoke | — |
| 9–16 | Typed block graph + named typed block outputs + wiring | ✅ 6 block kinds (`create-variable`, `get-object-property`, `use-llm`, `execute-function`, `transform`, `branch`), each emits a named typed output referenced via `RefPicker` (no freeform JSON) | `_block-graph.ts` |
| 11 | Use LLM block | ✅ one grounded turn on the live AOAI deployment (tier/temperature/max-tokens routed) | AOAI `chatGrounded` |
| 12 | Apply-action tool | ✅ real parameterised Synapse CRUD (propose SQL or commit) | Synapse dedicated pool |
| 13 | Execute-function / ontology-function tools | ✅ sibling `/invoke` recursion + real Synapse property read | AOAI + Synapse |
| 14 | Transform block | ✅ deterministic map/derive (template, case, length, json, …) | in-process |
| 15 | Conditional / branch | ✅ branch block (ternary over a prior output) | in-process |
| 17 | Use-LLM tool config | ✅ `AipToolEditor` (Apply-action / Ontology-function / Execute-function) | — |
| 18 | Typed Value output | ✅ `outputType` + description, prompt-enforced + coerced | — |
| 18b | Ontology-edits output | ✅ via `apply-action` tool (proposes the real SQL by default; commits on demand) | Synapse |
| 19 | Capture intermediate outputs for eval | ⚠️ every block output is captured + shown in the Debugger; eval cases grade the final output (block-level assertions on the roadmap) | — |
| 20 | CoT display | ✅ Debugger shows the model's reasoning/answer text per turn | orchestrator/AOAI |
| 21 | Block cards | ✅ per-block accordion card: status, inputs, generated prompt/SQL, output, timing | `BlockExecStep` |
| 22 | Tool-call logs | ✅ per-block tool-call results rendered (apply-action SQL, sibling calls) | — |
| 23 | Proposed ontology edits | ✅ apply-action "propose only" returns the exact real SQL + bound params, shown in the Debugger | Synapse (dry) |
| 24 | Final output visualization | ✅ output `CodeBlock` in the Debugger pane | — |
| 25 | Run | ✅ Logic + Agent modes | AOAI + orchestrator |
| 25b | Generate sample output | ✅ "Generate sample inputs" fills typed placeholders from the input schema, then Run | in-process |
| 26 | Run history | ✅ persisted to Cosmos (`state.runs`); open a run to rehydrate output + Debugger | Cosmos |
| 27 | Unit tests (save inputs) | ✅ eval cases save typed inputs + criteria as reusable tests | Cosmos |
| 28 | Evals (suite) | ✅ **Evals tab** runs each case against the real block graph + LLM-judge scoring (`agent-eval`), avg-score + pass-rate | AOAI |
| 29 | Automations | ⚠️ cross-surface: schedule the published REST/agent from the **Activator** editor (Azure Monitor scheduled-query alert / Logic App) — not yet a one-click button on Spindle | Azure Monitor |
| 30 | Save + Publish | ✅ Save (ribbon) + Publish-as-REST + Publish-as-agent | Cosmos + APIM + Foundry |
| 30b | Publish as REST function + Uses/curl | ✅ **evals-gated** APIM publish (`importApiFromOpenApi`) → typed `POST /invoke` + Uses curl | APIM → `/invoke` |
| 31 | Version history + diff | ✅ Versions tab: snapshot (manual + auto-on-publish) + two-version diff (added/edited/removed) | Cosmos + `diffSnapshots` |
| 32 | Wrap as Action | ⚠️ cross-surface: the bound ontology's **Actions** editor authors an Action; Spindle's apply-action tool already performs the same real Synapse write | Synapse |
| 33 | Operational reuse | ✅ published REST callable externally; Execute-function calls it from sibling Logic; Foundry agent runnable | APIM / recursion / Foundry |
| 34 | Uses curl | ✅ (see #4) | — |
| 35 | Execution-mode settings | ✅ Settings panel: default Logic/Agent mode | `state.settings` |
| 36 | Model / capacity selection | ✅ Settings panel: model **tier** (mini/standard/strong via `model-tier-router`) + temperature + max-tokens; honest AOAI gate when no deployment | AOAI |
| 37 | Compute / token metrics | ✅ Run history surfaces per-run token usage; eval summary surfaces avg-score/pass-rate | AOAI usage |

**Evals-in-CI publish gate (the WS-4.6 hard requirement):** `POST /api/items/aip-logic/[id]/publish` runs the attached eval suite against the REAL block graph BEFORE any APIM import and returns `409 eval_gate_failed` (with the failing rows) unless the suite clears its threshold + min-pass-rate. No suite ⇒ no publish. On pass it imports the typed OpenAPI into APIM, snapshots a version, and returns the callable URL + a working curl.

**Honest assessment:** Spindle is now a full AIP-Logic studio — 3-pane resizable shell, 16 typed input types, a real typed block graph with named typed outputs + real Azure-native backends per block, a per-block Debugger with proposed-edit SQL and timings, run history, an evals suite that gates a real APIM REST publish, a version diff, and a model/settings panel that actually routes the AOAI turn. Zero ❌: the only ⚠️ rows are cross-surface (Automations via Activator, Wrap-as-Action via the Ontology Actions editor) or a roadmap refinement (block-level eval assertions) — each backed by a real platform capability, none a stub.

---

## Verification per merge

With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET: create a Spindle item, define typed inputs (incl. an object type bound to a Weave ontology), build a block graph (create-variable → use-LLM with an Apply-action tool → transform), **Invoke** and confirm the Debugger shows per-block cards with real AOAI output + Synapse-backed grounding + proposed-edit SQL, persist a run in Run history, author an eval case and **Run evals** (real AOAI judge), attempt **Publish as REST** and confirm it is BLOCKED until the eval suite passes, then on pass exercise the Uses-tab **curl** against the APIM gateway, and diff two **Versions** — all real Azure responses, zero Fabric calls. Foundry-agent publish remains the opt-in path (honest 501 in Gov).

**Owed (Track-0):** a browser-E2E receipt of the full loop (author → debug → eval-gate → publish-as-REST with a working curl) on a live deployment.
