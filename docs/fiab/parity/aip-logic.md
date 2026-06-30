# aip-logic — parity with Palantir AIP Logic (typed AI logic + tool-calling agents)

Loom slug: `aip-logic` · restType `AipLogic` · category **Fabric IQ** · brand **Spindle (Spindle Studio)** · editor `apps/fiab-console/lib/editors/palantir-editors.tsx` → `AipLogicEditor`.

**Source UI:** Palantir AIP Logic — <https://www.palantir.com/docs/foundry/logic/getting-started>
(3-pane no-code studio: Inputs/Blocks/Outputs · Debugger · Run panel.)

**Cloud rule:** Azure-native is the DEFAULT and is fully functional with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. LLM runtime = **Azure OpenAI** (`data-agent-client` / `copilot-orchestrator`); ontology data = **Synapse / ADX / ADLS** via the bound Weave ontology; persistence = **Cosmos**; publish = **APIM + Data API Builder / Azure Functions**; automation = **Azure Monitor / Logic Apps**. Azure AI Foundry Agent Service is an opt-in publish target (Gov-gated). No Microsoft Fabric / Power BI dependency anywhere on the default path.

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
33. Use published Logic operationally — in Workshop (Markdown widget needs string output), in Automations, called from other Logic / functions-on-objects.
34. **Uses** tab curl for external REST invocation.

### H. Settings / admin
35. **Execution mode** settings.
36. **Model / LLM capacity** selection; enable-AIP gates.
37. **Compute / metrics** (compute usage, run metrics).

---

## Loom coverage (current state)

Legend: ✅ built · ⚠️ honest-gate / partial · ❌ MISSING

| # | Real capability | Loom today | Backend today |
|---|---|---|---|
| 1 | 3-pane studio layout | ❌ flat stacked sections (`s.section` cards) | — |
| 6 | Typed input types | ⚠️ only `string / number / boolean` (3 of 16) | persisted in `state.inputs` |
| 7–8 | object / model / media / struct / date inputs | ❌ | — |
| 9–16 | Rich block model + block outputs/wiring | ⚠️ steps are `{kind: llm-prompt\|extract\|branch, name, prompt}` strings; no per-block config, no typed block outputs, no variable references | composed into one system prompt |
| 11 | Use LLM block | ⚠️ implicit (whole step list → one prompt) | ✅ real AOAI `chatGrounded` |
| 12–13 | Apply-action / Execute-function / ontology-function tools | ❌ (agent mode exposes the generic Loom tool registry, but no typed Apply-action / call-Logic blocks) | partial (orchestrator registry) |
| 18 | Typed Value output | ✅ `outputType` (string/number/boolean/object) + description | prompt-enforced |
| 18b | Ontology-edits output | ❌ | — |
| 19 | Capture intermediate outputs for eval | ❌ | — |
| 20–24 | Debugger (CoT, block cards, tool logs, proposed edits) | ⚠️ flat run-trace list (agent steps only) | ✅ orchestrator step trace |
| 25 | Run / invoke | ✅ Logic + Agent modes | ✅ AOAI + orchestrator |
| 25b | Generate sample output | ❌ | — |
| 26 | Run history | ❌ (run is ephemeral, not persisted) | — |
| 27 | Unit tests (save inputs) | ❌ | — |
| 28 | Evals (block/suite) | ❌ | — |
| 29 | Automations | ❌ | — |
| 30 | Save | ✅ | ✅ Cosmos PATCH |
| 30b | Publish as REST function + Uses/curl | ❌ (only "Deploy as Foundry agent") | — |
| 31 | Version history + diff | ❌ | — |
| 32 | Wrap as Action | ❌ | — |
| —  | Deploy as Foundry agent + run+inspect | ✅ (opt-in, Gov-gated honest 501) | ✅ Foundry Agent Service |
| 35–36 | Execution-mode / model / temperature settings | ⚠️ Logic/Agent switch only; no model picker, no temperature/max-tokens | model = resolved AOAI deployment |
| 37 | Compute / token metrics | ❌ (usage returned by invoke but never surfaced) | usage in AOAI response |

**Honest assessment:** the *backend* is genuinely strong — Invoke (Logic + Agent) hits live Azure OpenAI, ontology grounding runs real Synapse/ADX queries, and Foundry-agent publish/run-inspect is real. But the *editor surface is thin*: a flat column of cards, a 3-type input system, "steps" that are just name+prompt strings flattened into one prompt (no real block graph, no block outputs, no typed Apply-action / call-function blocks), no debugger, no run history, no unit tests/evals, no version diff, no publish-as-REST-function, no model/settings panel, and token usage is computed but never shown. It reads as a demo of one AIP Logic feature (run a prompt chain), not the AIP Logic studio.

---

## Build plan (prioritized)

### P0 — make it the AIP Logic studio (visible parity uplift)

**P0-1 · Three-pane Spindle Studio shell.** Replace the flat `s.section` stack with a 3-column layout inside `ItemEditorChrome`: **left rail** = Inputs / Blocks / Outputs accordion boards (`PageShell`-style panels, Loom tokens, `EmptyState` per empty board), **center** = Debugger, **right** = Run panel. Fluent v9 only; `minmax(0,1fr)` columns, height-bounded, `flexWrap` to stack on narrow. Backend: none (layout).

**P0-2 · Full typed-input system.** Expand the input type `Dropdown` to the AIP Logic set (`string, integer, long, double, float, boolean, date, timestamp, array, struct, object, object list, object set, model, media reference`). For `object*` types add a second `Dropdown` bound to the **bound ontology's entity types** (reuse `useOntologyBinding` → `surface.classes`). Add per-input `description` + `required` + default value. Backend: persisted in `state.inputs`; object types validated against the ontology surface (real `bind-ontology` route, already live).

**P0-3 · Real block model with typed block outputs + wiring.** Replace string "steps" with typed blocks, each configured by **dropdowns/wizards (no freeform JSON)** and each emitting a **named, typed output variable** that later blocks reference via a variable `Dropdown`. Block types: `create-variable`, `get-object-property`, `use-llm`, `apply-action`, `execute-function`, `transform`, `branch`. Build a `BlockCard` component (Fluent `Card`, accent icon per kind, drag-reorder via existing canvas-node-kit patterns or up/down). Backend: extend `composePrompt`/`composeAgentInstructions` to render the block graph + variable bindings; the invoke route already drives AOAI — pass the resolved block graph instead of flat steps.

**P0-4 · Debugger pane.** Promote the current flat run-trace into a real debugger: per-block **execution cards** (status badge, inputs, the generated prompt, the output, tool calls, elapsed ms), expand/collapse (Fluent `Accordion`), error rows tinted red, CoT text from the orchestrator `final`/intermediate steps. Backend: already returned by `invoke` (logic `tools`/`usage`) and `orchestrate` (`OrchestratorStep[]`) — enrich the step payload with per-block id + timing; no new service.

**P0-5 · Use-LLM tool config + typed Apply-action / Execute-function blocks.** On `use-llm` blocks, a **tools** multiselect: *Apply action* (pick an ontology Action → writes via the same Synapse `/run-action` path Workshop already uses), *Call function* (pick another `aip-logic` item → invokes its REST), *Loom data tools* (ADX/Synapse/ADLS from the registry). Backend: `apply-action` reuses `workshop-app /run-action` (real Synapse dedicated-pool CRUD); `execute-function` calls the sibling `aip-logic .../invoke`; data tools = existing `buildDefaultRegistry()`.

### P1 — operationalize + test/version (matches AIP Logic Run panel + Publish)

**P1-6 · Run history.** Persist every invoke/run to a Cosmos `runs` sub-collection (inputs, output, steps, usage, model, ts). Right-pane **Run history** list (`Table`, Loom tokens) → click a run to rehydrate the Debugger. Backend: new `POST/GET /api/items/aip-logic/[id]/runs` over Cosmos (`itemsContainer` pattern); invoke route writes a run doc on completion.

**P1-7 · Unit tests + Evals.** Save the current inputs (+ optional expected value / assertion) as a named **unit test** (Cosmos); a **Run tests** action re-invokes each and shows pass/fail badges; block-level assertions (output contains / equals / regex) for AIP-Evals parity. Backend: new `/api/items/aip-logic/[id]/tests` (Cosmos CRUD) + reuse `invoke` per test; assertions evaluated server-side.

**P1-8 · Version history + diff.** On **Publish**, snapshot `state` into a Cosmos `versions` sub-collection; a **Versions** dialog lists snapshots and a **Compare** view diffs blocks/inputs/outputs (added / edited / removed, color-coded). Backend: new `/api/items/aip-logic/[id]/versions` (Cosmos); diff computed client-side from two snapshots.

**P1-9 · Publish as REST function + Uses/curl tab.** Add **Publish as function** (distinct from Foundry-agent deploy): generate a typed REST endpoint for the Logic via **Data API Builder / Azure Functions + APIM** (mirror `ontology-sdk /publish` → APIM), then a **Uses** tab showing the live invoke URL + a copy-able `curl` snippet (reuse `CodeBlock`). Backend: new `/api/items/aip-logic/[id]/publish` → APIM operation pointing at the existing `/invoke` route (or a generated DAB/Functions wrapper); honest gate if `LOOM_APIM_*` unset.

**P1-10 · Wrap as Action / Automation.** Two CTAs: *Create ontology Action* backed by this Logic (registers an Action on the bound ontology that calls `/invoke` and applies edits via Synapse `/run-action`), and *Create automation* (Azure Monitor scheduledQueryRule or Logic App that invokes the published function on a schedule/trigger — reuse `health-check /rule`). Backend: ontology-action write (Cosmos + Synapse); automation = Azure Monitor (`monitor-client`) / Logic Apps.

**P1-11 · Model + execution settings panel.** A **Settings** board: model `Dropdown` populated from the live AOAI deployments (list deployments via the AOAI/Foundry control plane), temperature + max-tokens sliders, default execution mode (Logic vs Agent), max-iterations for agent. Backend: persisted in `state.settings`; passed through to `data-agent-client` / `orchestrate`; deployment list from `resolveAoaiTarget` + control-plane list.

### P2 — polish + advanced parity

**P2-12 · Generate sample output.** A **Generate sample** button that asks AOAI to synthesize representative input values from the typed schema and runs once. Backend: `invoke` with a "sample" flag (AOAI generates inputs).

**P2-13 · Ontology-edits output + proposed-edits preview.** Add `ontology-edits` as an output mode; when an `apply-action` block runs in test, show **proposed edits** in the Debugger (diff of rows) and only commit when invoked via a published Action (parity with AIP Logic's non-applied in-editor edits). Backend: dry-run mode on `/run-action` (compute diff, don't commit).

**P2-14 · model / media-reference input runtimes.** `model` input → pick an AOAI/Foundry model deployment; `media reference` → ADLS blob handle picker. Backend: AOAI deployment list; ADLS `adls-client` browse.

**P2-15 · Compute / token metrics.** A **Metrics** strip/tab aggregating per-run token `usage` (already returned) into totals + a small chart; optionally pull cost from App Insights. Backend: aggregate Cosmos `runs`; App Insights (`monitor-client`) optional.

---

### Verification per merge
With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET: create a Spindle item, define typed inputs (incl. an object type bound to a Weave ontology), build a 3-block graph (create-variable → use-LLM with an Apply-action tool → transform), **Invoke** and confirm the Debugger shows per-block cards with real AOAI output + Synapse-backed grounding, save a unit test and re-run it green, persist a run in Run history, **Publish as function** and exercise the Uses-tab curl against APIM — all real Azure responses in the receipt, zero Fabric calls. Foundry-agent publish remains the opt-in path (honest 501 in Gov).
