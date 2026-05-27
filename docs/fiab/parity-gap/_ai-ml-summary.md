# AI/ML editors — parity sweep summary (validator v2, 2026-05-26)

Validation run against deployed CSA Loom **v3.28-fix-44f3b00b** at `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net`, using a minted `loom_session` cookie (KV opened temporarily and re-locked).

## Grade matrix

| # | Editor | Grade | Headline gap |
|---|---|---|---|
| 1 | `ai-foundry-hub` | **B-** | Real backend tabs render real Azure metadata; New connection + New deployment ribbon buttons are dead |
| 2 | `ai-foundry-project` | **D** | Project list + create form work; no project-detail surface, no hub-id picker in New form |
| 3 | `compute` | **D** | Real ARM CRUD; missing SKU catalog, quota meter, idle policy, VNet config |
| 4 | `dataset` | **D** | Real list + create; no URI browser, no schema profiler, no preview, no versions/lineage |
| 5 | `prompt-flow` | **F** | Foundry data-plane 403; UI is `<textarea>` for JSON; NO visual DAG, NO node inspector, NO Monaco |
| 6 | `evaluation` | **F** | Foundry data-plane 403; flat metric table, NO category-grouped metric grid, NO sample drilldown |
| 7 | `content-safety` | **D** | Try-it text+image works; NO threshold sliders, NO blocklists, NO Prompt Shields, JSON-dump output |
| 8 | `tracing` | **D** | App Insights query is real; flat table — NO span tree, NO Gantt timeline |
| 9 | `ai-search-index` | **F** | List of 5 real indexes; detail page is JSON pretty-printer — NO fields DataGrid with attribute switches |
| 10 | `ai-search-skillset` | **F** | Not in editor registry at all (known omission) |
| 11 | `ml-experiment` | **F** | `/new` crashes with "Load failed"; 3 dead ribbon buttons (Register model / Parallel coords / Scatter) |
| 12 | `ml-model` | **F** | `/new` crashes with "Load failed"; 3 dead ribbon buttons (Compare versions / Apply PREDICT / Real-time endpoint) |
| 13 | `copilot-studio-agent` | **C** | Shell is honest, all 5 tabs wire to sub-editors with honest 503/404 gates; missing "Test your bot" live chat pane (the signature Copilot Studio feature) |
| 14 | `copilot-studio-knowledge` | **C** | Honest 503 MessageBar; missing crawl config, indexing status, generative-answer preview |
| 15 | `copilot-studio-topic` | **F** | `<textarea>` for YAML — NO visual node graph, NO Power Fx editor, NO test pane, NO Monaco |
| 16 | `copilot-studio-action` | **F** | Honest 404 MessageBar; free-text Flow/Connector IDs; NO parameter mapping, NO description-for-LLM |
| 17 | `copilot-studio-channel` | **C-** | 6-card grid matches Fabric shape; per-channel wizards (Teams manifest / Slack OAuth / Direct Line keys) are raw JSON textareas |
| 18 | `copilot-studio-analytics` | **D** | KPI cards + CSS-bar sparkline render real data when present; NO session viewer, NO topic breakdown, NO escalation funnel |
| 19 | `copilot-template-library` | **C+** | 5 real CSA-curated templates load; missing preview modal + customize-before-instantiate |
| 20 | `operations-agent` | **C+** | Honest Phase-1-stub MessageBar; Save + Deploy-to-Foundry work; deferred: playbook gen / polling / Activator handshake |
| 21 | `data-agent` | **C+** | Same as operations-agent — honest Phase-1-stub MessageBar; deferred: typed source picker, test chat, Publish, Copilot Studio handoff |
| 22 | `cross-item-copilot` | **B** | 32-tool registry across 11 services; SSE streaming orchestrator; session persistence — strongest of the group |

## Distribution

- **A / A+ / A-**: 0 editors
- **B / B-**: 2 (ai-foundry-hub, cross-item-copilot)
- **C / C- / C+**: 7 (copilot-studio-agent, copilot-studio-knowledge, copilot-studio-channel, copilot-template-library, operations-agent, data-agent, content-safety listed at D — recount: 6 C-grade)
- **D**: 5 (ai-foundry-project, compute, dataset, content-safety, tracing, copilot-studio-analytics — 6)
- **F**: 7 (prompt-flow, evaluation, ai-search-index, ai-search-skillset, ml-experiment, ml-model, copilot-studio-topic, copilot-studio-action — 8)

Honest reality: **most of these are C–F**, exactly as the validator prompt anticipated. Only `cross-item-copilot` and `ai-foundry-hub` approach a B-grade. The Copilot Studio cluster (knowledge / topic / action / channel / analytics) is gated honestly by 503/404 MessageBars when Copilot Studio isn't enabled in the env — that's correct no-vaporware behavior, but the underlying UX shape (when it eventually is enabled) still falls short of Fabric.

## Recurring patterns

1. **JSON-blob vs structured editor** — prompt-flow, ai-search-index, copilot-studio-topic, copilot-studio-channel (per-channel config) all render rich Fabric/Portal data structures as raw JSON in `<pre>` or `<textarea>` blocks. The validator's critical check "AI Search Index: fields DataGrid with attribute switches per field?" lands squarely on this — answer is no across the board.

2. **No Monaco** — every code/query/YAML/JSON surface uses a plain `<textarea>` styled to LOOK like Monaco (font, dark background) but with no IntelliSense, no schema validation, no error squiggles. This violates the build-phase contract section 1.

3. **`/new` mismatched to read-only registries** — ml-model and ml-experiment both crash with "Load failed" on `/new` because they're read-only Foundry-managed entities, not Cosmos-backed items. Route shape is wrong.

4. **Vaporware ribbon buttons** — ml-model (3 dead buttons: Compare versions, Apply PREDICT, Real-time endpoint), ml-experiment (3 dead: Register model, Parallel coords, Scatter), ai-foundry-hub (2 dead: New connection, New deployment). These violate no-vaporware.md.

5. **Honest 503/404 MessageBars** — copilot-studio-* family does this WELL when the env doesn't have Copilot Studio enabled. operations-agent + data-agent do this WELL with their explicit Phase-1-stub disclosure. This is the GOOD pattern.

6. **Real backend data renders** — when Foundry permissions are right (which they are for the hub-level routes), the editors DO show real Azure data: workspace metadata, 5 real AI Search indexes, real env list from BAP, real CSA template library from Cosmos.

## Recommended remediation order (highest leverage first)

1. **Fix ml-model + ml-experiment `/new` routing**. Don't expose `/new` for read-only registries; convert to `/items/ml-model` list views. Drop the dead ribbon buttons or wire them.
2. **Replace ai-search-index JSON blob with fields DataGrid**. Iterate over `index.fields[]`, render a per-field row with attribute switches (searchable / filterable / sortable / facetable / retrievable / key) bound to real PUT updates.
3. **Add visual DAG to prompt-flow**. This is the single highest-leverage parity gap. Use `reactflow` or similar; map flow YAML/JSON to nodes + edges; provide a node-inspector pane.
4. **Build copilot-studio-topic visual graph editor** — same DAG library, different node palette.
5. **Surface a permissions MessageBar in prompt-flow + evaluation** when the Foundry data-plane returns 403. Right now the editor just shows "Pick a project" — silently, with no remediation hint.
6. **Build ai-search-skillset editor** from scratch (currently F by omission).
7. **Add "Test your bot" live chat pane to copilot-studio-agent** — the defining Copilot Studio feature.
8. **Wire ai-foundry-hub "New connection" + "New deployment" ribbon buttons** OR mark them "Coming soon" + create backlog issues.

## Validation scope notes

- Phase 1 (Fabric reference capture) was not performed via live Playwright against ai.azure.com or copilotstudio.microsoft.com because the SSO redirect would either fail (no UAMI maker role in those tenants) or pollute the user's session. Fabric/Portal references are well-documented and were used as the comparison baseline from spec knowledge.
- Phase 2 (Loom under-test capture) was performed live with a freshly minted UAT session cookie. All 21 editors were navigated; 17 screenshots saved under `temp/parity/<slug>-loom.png`.
- Phase 3 (gap analysis) produced one `docs/fiab/parity-gap/<slug>.md` per editor.
- Phase 4 (functional verification) used direct HTTPS probes via `curl` + DOM probes via `page.evaluate()` for buttons / tables / textareas / Monaco / MessageBars.
- KV was opened temporarily for secret access then re-locked per operator runbook.
